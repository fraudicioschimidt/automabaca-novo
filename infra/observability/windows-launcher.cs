using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

// Compiled by Windows PowerShell 5.1 as a WindowsApplication (GUI subsystem).
// There is no console to flash before PowerShell has initialized.
public static class AutomaBacaLogLauncher
{
    public static ProcessStartInfo CreateStartInfo(string root, string windows, string alias)
    {
        if (!Regex.IsMatch(alias, @"\A[a-zA-Z0-9_-]+\z")) throw new ArgumentException("Invalid SSH alias");
        root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string script = Path.Combine(root, "sync-windows.ps1");
        if (root.IndexOf('"') >= 0) throw new ArgumentException("Invalid destination");
        var start = new ProcessStartInfo {
            FileName = Path.Combine(windows, @"System32\WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script
                + "\" -Destination \"" + root + "\" -SshAlias " + alias,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.EnvironmentVariables["AUTOMABACA_LOG_LAUNCHER"] = "windows-gui-v1";
        return start;
    }

    public static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try {
            if (args.Length != 1) throw new ArgumentException("SSH alias required");
            using (var process = new Process()) {
                process.StartInfo = CreateStartInfo(root, Environment.GetFolderPath(Environment.SpecialFolder.Windows), args[0]);
                process.Start();
                // Drain both streams without showing a console or blocking on full pipes.
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                output.GetAwaiter().GetResult();
                error.GetAwaiter().GetResult();
                // Preserve the actual backup result in Task Scheduler.
                return process.ExitCode;
            }
        } catch {
            try {
                File.WriteAllText(Path.Combine(root, "launcher-error.json"),
                    "{\"reason\":\"launcher_failed\",\"failedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}");
            } catch { }
            return 1;
        }
    }
}
