# Copia do pacote diario de recuperacao para o computador do dono (tarefa do
# Windows "AutomaBACA - Backup criptografado"). Le exports/latest.json na VPS,
# baixa o .tar.age, confere tamanho e SHA-256, guarda 7 dias (nunca menos que os
# 2 ultimos conferidos) e devolve a VPS um comprovante, que o watchdog.py le:
# sem comprovante recente o painel avisa backup_offsite_stale.
# Somente ASCII: o Windows PowerShell 5.1 le arquivo sem BOM como ANSI.
param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [string]$SshAlias = 'hermes',
    [ValidateRange(30,3600)][int]$TransferTimeoutSeconds = 3600
)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($Destination)
if ($root.Length -gt [IO.Path]::GetPathRoot($root).Length) { $root = $root.TrimEnd('\','/') }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Backup directory must be created by the owner first.' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup directory cannot be a link.' }
if ($SshAlias -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid SSH alias.' }
$scpPath = (Get-Command scp.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$sshPath = (Get-Command ssh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$sshOptions = @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3')
$remoteReceipts = '/var/lib/automabaca-novo/observability-receipts'

function Assert-SafeChild([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetDirectoryName($absolute),$root)) { throw 'Backup path outside destination.' }
    if (Test-Path -LiteralPath $absolute) {
        $item = Get-Item -LiteralPath $absolute -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup file cannot be a directory or link.' }
    }
}
function Quote-NativeArgument([string]$Value) {
    # Windows CRT quoting, including quotes and trailing backslashes; compatible with PowerShell 5.1 and 7.
    if ($Value.Contains([char]0)) { throw 'Invalid process argument.' }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Invoke-Hidden([string]$Executable, [string[]]$ProcessArguments, [int]$TimeoutSeconds, [switch]$ReturnOutput) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = ($ProcessArguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            # Only terminate this transfer tree, including its ssh child.
            $killStart = New-Object Diagnostics.ProcessStartInfo
            $killStart.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            $killStart.Arguments = '/PID ' + $process.Id + ' /T /F'
            $killStart.UseShellExecute = $false
            $killStart.CreateNoWindow = $true
            $killStart.RedirectStandardOutput = $true
            $killStart.RedirectStandardError = $true
            $killer = [Diagnostics.Process]::Start($killStart)
            try { [void]$killer.WaitForExit(10000) } finally { $killer.Dispose() }
            [void]$process.WaitForExit(10000)
            throw 'Encrypted transfer deadline exceeded.'
        }
        $captured = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Encrypted transfer failed.' }
        if ($ReturnOutput) { return $captured }
    } finally { $process.Dispose() }
}
function Receive-RemoteFile([string]$Remote, [string]$Local, [int]$TimeoutSeconds) {
    Assert-SafeChild $Local
    Invoke-Hidden $scpPath (@('-q') + $sshOptions + @($Remote,$Local)) $TimeoutSeconds
}
# Small independent reads recover on paths where a long SSH stream stalls.
# Persist only complete blocks; the manifest checksum still decides acceptance.
function Receive-ArchiveBlocks([string]$RemotePath, [string]$Local, [long]$Size, [int]$TimeoutSeconds) {
    Assert-SafeChild $Local
    $blockSize = 65536
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $file = [IO.File]::Open($Local,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        if ($file.Length -gt $Size) { $file.SetLength(0) }
        if ($file.Length -lt $Size) { $file.SetLength($file.Length - ($file.Length % $blockSize)) }
        $file.Position = $file.Length
        while ($file.Length -lt $Size) {
            $index = [long]($file.Length / $blockSize)
            $expected = [int][Math]::Min($blockSize,$Size - $file.Length)
            $received = $false
            for ($attempt = 0; $attempt -lt 3; $attempt++) {
                $remaining = [int][Math]::Floor($TimeoutSeconds - $watch.Elapsed.TotalSeconds)
                if ($remaining -lt 1) { throw 'Encrypted recovery deadline exceeded.' }
                try {
                    $command = "dd if=$RemotePath bs=$blockSize skip=$index count=1 status=none | base64 -w0"
                    $encoded = Invoke-Hidden $sshPath ($sshOptions + @($SshAlias,$command)) ([Math]::Min(30,$remaining)) -ReturnOutput
                    $bytes = [Convert]::FromBase64String($encoded)
                    if ($bytes.Length -ne $expected) { throw 'Incomplete encrypted block.' }
                    $received = $true
                    break
                } catch { if ($attempt -eq 2) { throw 'Encrypted block recovery failed.' } }
            }
            if (-not $received) { throw 'Encrypted block recovery failed.' }
            $file.Write($bytes,0,$bytes.Length)
            $file.Flush($true)
        }
    } finally { $file.Dispose(); $watch.Stop() }
}
# The VPS only trusts a receipt it received: it is the proof this copy still runs.
function Send-Receipt([string]$Local) {
    Assert-SafeChild $Local
    $temporary = $remoteReceipts + '/.windows-backup-receipt-' + [Guid]::NewGuid().ToString('N') + '.json'
    Invoke-Hidden $scpPath (@('-q') + $sshOptions + @($Local,"${SshAlias}:${temporary}")) 60
    Invoke-Hidden $sshPath ($sshOptions + @($SshAlias,"mv -f -- $temporary $remoteReceipts/windows-backup-receipt.json")) 60
}
function Write-JsonAtomic([string]$Path, $Value) {
    Assert-SafeChild $Path
    $temporary = Join-Path $root ('.receipt-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 5))
        $file = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Assert-SafeChild $temporary; Remove-Item -LiteralPath $temporary -Force } }
}

$lockFile = $null
$manifestPath = $null
$partial = $null
$keepPartial = $false
$failure = 'computer_backup_download_failed'
try {
    # A file lock covers interactive and scheduled runs across Windows sessions.
    $lockPath = Join-Path $root '.computer-backup.lock'
    Assert-SafeChild $lockPath
    try { $lockFile = [IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
    catch [IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 32) { exit 0 }; throw }
    $manifestPath = Join-Path $root ('.latest-' + [Guid]::NewGuid().ToString('N') + '.download.json')
    Receive-RemoteFile "${SshAlias}:/srv/apps/automabaca-novo/exports/latest.json" $manifestPath 60
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 65536) { throw 'Backup manifest too large.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.name -notmatch '^automabaca-novo-recovery-\d{8}T\d{6}Z\.tar\.age$' -or $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or
        ($manifest.sizeBytes -isnot [int] -and $manifest.sizeBytes -isnot [long]) -or $manifest.sizeBytes -lt 1) { throw 'Invalid backup manifest.' }
    $created = [DateTimeOffset]::MinValue
    $databaseAt = [DateTimeOffset]::MinValue
    foreach ($field in @('createdAt','databaseVerifiedAt')) {
        if ($manifest.$field -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$') { throw 'Invalid backup timestamp.' }
    }
    if (-not [DateTimeOffset]::TryParse($manifest.createdAt,[ref]$created) -or -not [DateTimeOffset]::TryParse($manifest.databaseVerifiedAt,[ref]$databaseAt)) { throw 'Invalid backup timestamp.' }
    $now = [DateTimeOffset]::UtcNow
    if ($created -gt $now.AddSeconds(30) -or $databaseAt -gt $created.AddSeconds(30)) { throw 'Future backup timestamp.' }
    $target = Join-Path $root $manifest.name
    Assert-SafeChild $target
    $verified = (Test-Path -LiteralPath $target -PathType Leaf) -and ((Get-Item -LiteralPath $target).Length -eq $manifest.sizeBytes) -and ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ieq $manifest.sha256)
    if (-not $verified) {
        $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))
        if ($drive.AvailableFreeSpace -lt $manifest.sizeBytes + 1GB) { throw 'Insufficient free space for encrypted backup.' }
        $partial = Join-Path $root ('.' + $manifest.name + '.partial')
        Assert-SafeChild $partial
        $keepPartial = $true
        $remotePath = "/srv/apps/automabaca-novo/exports/$($manifest.name)"
        if (-not (Test-Path -LiteralPath $partial)) {
            try { Receive-RemoteFile "${SshAlias}:${remotePath}" $partial ([Math]::Min(300,$TransferTimeoutSeconds)) }
            catch { Receive-ArchiveBlocks $remotePath $partial $manifest.sizeBytes $TransferTimeoutSeconds }
        } else { Receive-ArchiveBlocks $remotePath $partial $manifest.sizeBytes $TransferTimeoutSeconds }
        if ((Get-Item -LiteralPath $partial).Length -ne $manifest.sizeBytes -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $manifest.sha256) {
            $keepPartial = $false
            throw 'Encrypted backup checksum mismatch.'
        }
        Assert-SafeChild $target
        if (Test-Path -LiteralPath $target) { [IO.File]::Replace($partial,$target,[NullString]::Value) }
        else { [IO.File]::Move($partial,$target) }
        $partial = $null
    }
    $now = [DateTimeOffset]::UtcNow
    $freshSource = ($now - $databaseAt).TotalHours -le 30
    $receipt = [ordered]@{ lastCheckedAt=$now.ToString('o'); state=$(if ($freshSource) { 'verified' } else { 'stale' }); name=$manifest.name; sha256=$manifest.sha256; sizeBytes=$manifest.sizeBytes; databaseVerifiedAt=$manifest.databaseVerifiedAt; encrypted=$true; checksumVerified=$true }
    Write-JsonAtomic ($target + '.verified.json') $receipt
    Write-JsonAtomic (Join-Path $root 'last-success.json') $receipt
    # The copy is already safe here; a receipt that does not arrive fails the task without touching it.
    $failure = 'computer_backup_receipt_failed'
    $offsitePath = Join-Path $root 'offsite-receipt.json'
    Write-JsonAtomic $offsitePath ([ordered]@{ schemaVersion=1; project='automabaca-novo'; name=$manifest.name; sha256=$manifest.sha256; sizeBytes=$manifest.sizeBytes; verifiedAt=$now.ToString('o') })
    Send-Receipt $offsitePath
    $failure = 'computer_backup_rotation_failed'
    # Rotate only copies with matching recorded checksums; retain two actually verified archives.
    $archives = @(Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match '^automabaca-novo-recovery-\d{8}T\d{6}Z\.tar\.age$' } | Sort-Object Name -Descending)
    $keepers = 0
    foreach ($archive in $archives) {
        $absolute = [IO.Path]::GetFullPath($archive.FullName)
        $proofPath = $absolute + '.verified.json'
        Assert-SafeChild $absolute
        Assert-SafeChild $proofPath
        if (-not (Test-Path -LiteralPath $proofPath -PathType Leaf)) { continue }
        try { $proof = Get-Content -LiteralPath $proofPath -Raw | ConvertFrom-Json } catch { continue }
        if ($proof.name -cne $archive.Name -or $proof.sha256 -notmatch '^[a-f0-9]{64}$' -or $proof.sizeBytes -ne $archive.Length -or $proof.checksumVerified -ne $true) { continue }
        if ($keepers -ge 2 -and $archive.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddDays(-7)) { continue }
        if ((Get-FileHash -LiteralPath $absolute -Algorithm SHA256).Hash -ine $proof.sha256) { continue }
        if ($keepers -lt 2) { $keepers++; continue }
        if ($absolute -ne $target -and $archive.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7)) {
            Remove-Item -LiteralPath $absolute -Force
            Remove-Item -LiteralPath $proofPath -Force
        }
    }
    foreach ($abandoned in @(Get-ChildItem -LiteralPath $root -File -Force | Where-Object { $_.Name -match '^\.automabaca-novo-recovery-\d{8}T\d{6}Z\.tar\.age\.partial$' -and $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) })) {
        Assert-SafeChild $abandoned.FullName
        Remove-Item -LiteralPath $abandoned.FullName -Force
    }
    Write-JsonAtomic (Join-Path $root 'last-attempt.json') ([ordered]@{ observedAt=[DateTime]::UtcNow.ToString('o'); state=$(if ($freshSource) { 'success' } else { 'warning' }); code=$(if ($freshSource) { 'encrypted_copy_verified' } else { 'encrypted_copy_verified_source_stale' }) })
} catch {
    if ($lockFile) { Write-JsonAtomic (Join-Path $root 'last-attempt.json') ([ordered]@{ observedAt=[DateTime]::UtcNow.ToString('o'); state='error'; code=$failure }) }
    Write-Error ('AutomaBACA backup: ' + $failure + '. The existing copies were preserved.')
    exit 1
} finally {
    foreach ($temporary in @($manifestPath,$(if (-not $keepPartial) { $partial }))) {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Assert-SafeChild $temporary; Remove-Item -LiteralPath $temporary -Force }
    }
    if ($lockFile) { $lockFile.Dispose() }
}
