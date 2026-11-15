"""Run the real Windows backup script against local, synthetic SSH clients."""
import base64
import json
from pathlib import Path
import subprocess
import unittest

POWERSHELL = Path('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')

SCENARIOS = r'''
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('automabaca-backup-test-' + [Guid]::NewGuid().ToString('N'))
$oldPath = $env:PATH
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $env:AUTOMABACA_BACKUP_FIXTURE = $root
    $client = @'
using System;
using System.IO;
using System.Text.RegularExpressions;
class Client {
    static int Main(string[] args) {
        string root = Environment.GetEnvironmentVariable("AUTOMABACA_BACKUP_FIXTURE");
        if (String.IsNullOrEmpty(root)) return 99;
        string last = args[args.Length - 1];
        if (Path.GetFileName(Environment.GetCommandLineArgs()[0]).Equals("scp.exe", StringComparison.OrdinalIgnoreCase)) {
            string source = args[args.Length - 2];
            if (source.EndsWith("/latest.json")) { File.Copy(Path.Combine(root,"latest.json"),last,true); return 0; }
            if (source.EndsWith(".tar.age")) return 1;
            File.Copy(source,Path.Combine(root,"received.json"),true);
            return 0;
        }
        if (!last.StartsWith("dd ")) return 0;
        Match block = Regex.Match(last,@"bs=(\d+) skip=(\d+)");
        int size = Int32.Parse(block.Groups[1].Value);
        int index = Int32.Parse(block.Groups[2].Value);
        File.AppendAllText(Path.Combine(root,"requests.txt"),index + "\n");
        string mode = File.ReadAllText(Path.Combine(root,"mode.txt"));
        if (mode == "interrupt" && index > 0) return 1;
        byte[] all = File.ReadAllBytes(Path.Combine(root,"payload"));
        int offset = size * index;
        byte[] bytes = new byte[Math.Min(size,all.Length-offset)];
        Array.Copy(all,offset,bytes,0,bytes.Length);
        if (mode == "corrupt") bytes[0] ^= 1;
        string once = Path.Combine(root,"transient");
        if (mode == "complete" && index == 1 && !File.Exists(once)) {
            File.WriteAllText(once,"done");
            Console.Write(Convert.ToBase64String(new byte[1]));
        } else Console.Write(Convert.ToBase64String(bytes));
        return 0;
    }
}
'@
    Add-Type -TypeDefinition $client -OutputAssembly (Join-Path $root 'scp.exe') -OutputType ConsoleApplication
    Copy-Item (Join-Path $root 'scp.exe') (Join-Path $root 'ssh.exe')
    $env:PATH = $root + ';' + $oldPath
    $data = New-Object byte[] (65536 * 3 + 17)
    for ($i=0; $i -lt $data.Length; $i++) { $data[$i] = [byte]($i % 251) }
    [IO.File]::WriteAllBytes((Join-Path $root 'payload'),$data)
    $hash = (Get-FileHash (Join-Path $root 'payload') -Algorithm SHA256).Hash.ToLowerInvariant()
    $name = 'automabaca-novo-recovery-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.tar.age'
    $manifest = @{schemaVersion=1;name=$name;sha256=$hash;sizeBytes=$data.Length;createdAt=[DateTime]::UtcNow.ToString('o');databaseVerifiedAt=[DateTime]::UtcNow.ToString('o')}
    $manifest | ConvertTo-Json | Set-Content (Join-Path $root 'latest.json') -Encoding ASCII
    function Assert($condition,[string]$message) { if (-not $condition) { throw $message } }
    function Run-Backup([string]$destination) {
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = Join-Path $PSHOME 'powershell.exe'
        $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $BackupScript + '" -Destination "' + $destination + '" -TransferTimeoutSeconds 30'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($start)
        try {
            $output = $process.StandardOutput.ReadToEndAsync()
            $errorOutput = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Fixture deadline exceeded.' }
            [void]$output.GetAwaiter().GetResult()
            [void]$errorOutput.GetAwaiter().GetResult()
            return $process.ExitCode
        } finally { $process.Dispose() }
    }
    $destination = Join-Path $root 'copies'
    New-Item -ItemType Directory -Path $destination | Out-Null
    $abandoned = Join-Path $destination '.automabaca-novo-recovery-20000101T000000Z.tar.age.partial'
    [IO.File]::WriteAllBytes($abandoned,(New-Object byte[] 19))
    (Get-Item $abandoned).LastWriteTimeUtc = [DateTime]::UtcNow.AddDays(-8)
    $partial = Join-Path $destination ('.' + $name + '.partial')
    $target = Join-Path $destination $name
    'interrupt' | Set-Content (Join-Path $root 'mode.txt') -NoNewline
    Assert ((Run-Backup $destination) -eq 1) 'Interrupted download must fail.'
    Assert ((Get-Item $partial).Length -eq 65536) 'Complete blocks must survive interruption.'
    Assert (-not (Test-Path $target)) 'An incomplete archive must not be accepted.'
    Assert (-not (Test-Path (Join-Path $root 'received.json'))) 'An incomplete archive must not produce a receipt.'
    'complete' | Set-Content (Join-Path $root 'mode.txt') -NoNewline
    Assert ((Run-Backup $destination) -eq 0) 'Recovery must finish after a transient short block.'
    Assert ((Get-FileHash $target).Hash -ieq $hash) 'Recovered archive must match its manifest.'
    Assert (-not (Test-Path $partial)) 'Accepted partial must be renamed.'
    Assert (-not (Test-Path $abandoned)) 'Expired abandoned partials must be removed after success.'
    $requests = @(Get-Content (Join-Path $root 'requests.txt'))
    Assert (@($requests | Where-Object { $_ -eq '0' }).Count -eq 1) 'Recovery must resume after the saved block.'
    $receipt = Get-Content (Join-Path $root 'received.json') -Raw | ConvertFrom-Json
    Assert ($receipt.sha256 -eq $hash -and $receipt.name -eq $name) 'Receipt must identify the verified archive.'
    Assert ((Run-Backup $destination) -eq 0) 'A repeated run must succeed.'
    Assert (@(Get-Content (Join-Path $root 'requests.txt')).Count -eq $requests.Count) 'A verified copy must not be downloaded again.'
    $badDestination = Join-Path $root 'bad'
    New-Item -ItemType Directory -Path $badDestination | Out-Null
    $receiptBefore = [IO.File]::ReadAllText((Join-Path $root 'received.json'))
    'corrupt' | Set-Content (Join-Path $root 'mode.txt') -NoNewline
    Assert ((Run-Backup $badDestination) -eq 1) 'A changed encrypted block must fail verification.'
    Assert (-not (Test-Path (Join-Path $badDestination $name))) 'Corruption must not publish an archive.'
    Assert (-not (Test-Path (Join-Path $badDestination ('.' + $name + '.partial')))) 'Corruption must discard the poisoned partial.'
    Assert ([IO.File]::ReadAllText((Join-Path $root 'received.json')) -ceq $receiptBefore) 'Corruption must not refresh the remote receipt.'
    Assert ((Get-FileHash $target).Hash -ieq $hash) 'Existing verified copies must be preserved.'
    $tailDestination = Join-Path $root 'tail'
    New-Item -ItemType Directory -Path $tailDestination | Out-Null
    $prefix = New-Object byte[] (65536 + 19)
    [Array]::Copy($data,$prefix,65536)
    [IO.File]::WriteAllBytes((Join-Path $tailDestination ('.' + $name + '.partial')),$prefix)
    'complete' | Set-Content (Join-Path $root 'mode.txt') -NoNewline
    Assert ((Run-Backup $tailDestination) -eq 0) 'An interrupted local append must resume at a complete block.'
    Assert ((Get-FileHash (Join-Path $tailDestination $name)).Hash -ieq $hash) 'Truncated recovery must verify the complete archive.'
    [ordered]@{scenariosPassed=5} | ConvertTo-Json -Compress
} finally {
    $env:PATH = $oldPath
    Remove-Item Env:AUTOMABACA_BACKUP_FIXTURE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force
}
'''

@unittest.skipUnless(POWERSHELL.exists(), 'Requires Windows PowerShell through WSL interop')
class WindowsBackupTests(unittest.TestCase):
    def test_recovery_resume_integrity_and_repeated_execution(self):
        # The Linux CI account cannot necessarily launch the owner's Windows
        # session. Never turn an actual scenario failure into a platform skip.
        try:
            probe = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-Command', '[Console]::Write("ready")'], capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            self.skipTest('Windows PowerShell interop unavailable for this Linux account')
        if probe.returncode != 0 or probe.stdout.strip() != b'ready':
            self.skipTest('Windows PowerShell interop unavailable for this Linux account')
        script = Path(__file__).with_name('backup-windows.ps1').resolve()
        windows_path = subprocess.check_output(['wslpath', '-w', str(script)], text=True).strip()
        code = "$BackupScript = '" + windows_path.replace("'", "''") + "'\n" + SCENARIOS
        encoded = base64.b64encode(code.encode('utf-16le')).decode('ascii')
        result = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, 'Synthetic Windows backup scenarios failed')
        self.assertEqual(json.loads(result.stdout), {'scenariosPassed': 5})

if __name__ == '__main__':
    unittest.main()
