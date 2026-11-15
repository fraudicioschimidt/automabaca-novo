param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$SshAlias = 'hermes'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Diretorio de logs ausente.' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Diretorio de logs nao pode ser um link.' }
$scpExe = (Get-Command scp.exe -CommandType Application -ErrorAction Stop).Source
$sshExe = (Get-Command ssh.exe -CommandType Application -ErrorAction Stop).Source
$remoteRoot = '/srv/apps/automabaca-novo/exports/logs'

function Assert-Child([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($absolute), $root)) { throw 'Caminho fora do destino.' }
    if (Test-Path -LiteralPath $absolute) {
        $item = Get-Item -LiteralPath $absolute -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Arquivo inseguro.' }
    }
}
function Quote-Argument([string]$Value) {
    if ($Value.Contains([char]0)) { throw 'Argumento invalido.' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Invoke-HiddenProcess([string]$Executable, [string[]]$ProcessArguments, [int]$Timeout = 300) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = ($ProcessArguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $proc = New-Object Diagnostics.Process
    $proc.StartInfo = $start
    try {
        [void]$proc.Start()
        $stdout = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($Timeout * 1000)) {
            $killStart = New-Object Diagnostics.ProcessStartInfo
            $killStart.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            $killStart.Arguments = '/PID ' + $proc.Id + ' /T /F'
            $killStart.UseShellExecute = $false
            $killStart.CreateNoWindow = $true
            $killer = [Diagnostics.Process]::Start($killStart)
            try { if (-not $killer.WaitForExit(10000)) { $killer.Kill() } } finally { $killer.Dispose() }
            throw 'Prazo de transferencia excedido.'
        }
        [void]$stdout.GetAwaiter().GetResult()
        $diagnostic = $stderr.GetAwaiter().GetResult().Trim()
        if ($proc.ExitCode -ne 0) {
            if ($diagnostic.Length -gt 800) { $diagnostic = $diagnostic.Substring(0,800) }
            throw ('Falha na transferencia SSH (codigo ' + $proc.ExitCode + '): ' + $diagnostic)
        }
    } finally { $proc.Dispose() }
}
function Transfer([string]$From, [string]$To, [int]$Timeout = 300) {
    Invoke-HiddenProcess $scpExe @('-q','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes',
        '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3', $From, $To) $Timeout
}
function Write-AtomicJson([string]$Path, $Value) {
    Assert-Child $Path
    $temporary = Join-Path $root ('.write-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 6 -Compress))
        $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

$lock = $null
$temporaryIndex = Join-Path $root ('.index-' + [Guid]::NewGuid().ToString('N') + '.json')
$partial = $null
try {
    $lockPath = Join-Path $root '.sync.lock'
    Assert-Child $lockPath
    try { $lock = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch [IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 32) { exit 0 }; throw }
    Transfer "${SshAlias}:${remoteRoot}/index.json" $temporaryIndex 60
    if ((Get-Item -LiteralPath $temporaryIndex -Force).Length -gt 8MB) { throw 'Indice muito grande.' }
    $index = Get-Content -LiteralPath $temporaryIndex -Raw | ConvertFrom-Json
    $bundles = @($index.bundles)
    if ($index.schemaVersion -ne 1 -or $index.project -ne 'automabaca-novo' -or $bundles.Count -lt 1 -or $bundles.Count -gt 10000) { throw 'Indice de logs invalido.' }
    $verified = @()
    $names = New-Object 'Collections.Generic.HashSet[string]'
    foreach ($bundle in $bundles) {
        if ($bundle.name -isnot [string] -or $bundle.name -notmatch '^automabaca-logs-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age$' -or
            $bundle.sha256 -isnot [string] -or $bundle.sha256 -notmatch '^[a-f0-9]{64}$' -or
            ($bundle.sizeBytes -isnot [int] -and $bundle.sizeBytes -isnot [long]) -or $bundle.sizeBytes -lt 100 -or $bundle.sizeBytes -gt 1GB -or
            -not $names.Add($bundle.name)) { throw 'Entrada invalida no indice.' }
        $target = Join-Path $root $bundle.name
        Assert-Child $target
        $valid = (Test-Path -LiteralPath $target -PathType Leaf) -and
            ((Get-Item -LiteralPath $target -Force).Length -eq $bundle.sizeBytes) -and
            ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $bundle.sha256)
        if (-not $valid) {
            $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
            if ($drive.AvailableFreeSpace -lt $bundle.sizeBytes + 1GB) { throw 'Espaco livre insuficiente.' }
            $partial = Join-Path $root ('.' + $bundle.name + '.' + [Guid]::NewGuid().ToString('N') + '.partial')
            Transfer "${SshAlias}:${remoteRoot}/$($bundle.name)" $partial
            if ((Get-Item -LiteralPath $partial -Force).Length -ne $bundle.sizeBytes -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $bundle.sha256) { throw 'Checksum do pacote nao confere.' }
            if (Test-Path -LiteralPath $target) { [IO.File]::Move($target, $target + '.corrupt-' + [Guid]::NewGuid().ToString('N')) }
            [IO.File]::Move($partial,$target)
            $partial = $null
        }
        $verified += @{ name = $bundle.name; sha256 = $bundle.sha256 }
    }
    $receiptPath = Join-Path $root 'receipt.json'
    $receipt = @{ schemaVersion = 1; project = 'automabaca-novo'; verifiedAt = [DateTimeOffset]::UtcNow.ToString('o'); verified = $verified }
    if ($env:AUTOMABACA_LOG_LAUNCHER -eq 'windows-gui-v1') { $receipt.launcher = 'windows-gui-v1' }
    Write-AtomicJson $receiptPath $receipt
    $remoteReceipt = '/var/lib/automabaca-novo/observability-receipts/.windows-receipt-' + [Guid]::NewGuid().ToString('N') + '.json'
    Transfer $receiptPath "${SshAlias}:${remoteReceipt}" 60
    Invoke-HiddenProcess $sshExe @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes',
        '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3', $SshAlias,
        "mv -f -- $remoteReceipt /var/lib/automabaca-novo/observability-receipts/windows-receipt.json") 60
    # Runs outside the VPS, so a host/network outage also fails the Windows task.
    $appHealthy = $false
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $health = Invoke-RestMethod -Uri 'https://v2.fraudicio.com.br/api/health' -TimeoutSec 20
        $appHealthy = $health.ok -eq $true -and $health.db -eq $true -and $health.worker -eq $true
    } catch { $appHealthy = $false }
    Write-AtomicJson (Join-Path $root 'status.json') @{ ok = $appHealthy; copiedAt = $receipt.verifiedAt; verifiedBundles = $verified.Count; appHealthy = $appHealthy }
    # Rotate only this routine's exact encrypted filenames, after successful copying.
    $expired = Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match '^automabaca-logs-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.age$' -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-90) }
    foreach ($item in $expired) { Assert-Child $item.FullName; Remove-Item -LiteralPath $item.FullName -Force }
    if (-not $appHealthy) { throw 'Logs copiados, mas o health publico do aplicativo falhou.' }
    Write-Output ('Logs copiados e verificados: ' + $verified.Count + ' pacotes.')
} catch {
    Write-AtomicJson (Join-Path $root 'last-error.json') @{ failedAt = [DateTimeOffset]::UtcNow.ToString('o'); reason = 'sync_failed' }
    Write-Error $_
    exit 1
} finally {
    if ($partial -and (Test-Path -LiteralPath $partial)) { Assert-Child $partial; Remove-Item -LiteralPath $partial -Force }
    if (Test-Path -LiteralPath $temporaryIndex) { Assert-Child $temporaryIndex; Remove-Item -LiteralPath $temporaryIndex -Force }
    if ($lock) { $lock.Dispose() }
}
