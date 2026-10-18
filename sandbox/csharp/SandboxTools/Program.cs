// SandboxTools.exe: what logon.cmd runs before the boot (sandbox.cpuLimit, sandbox.pageFileMb) and the memory log
// that runs for the sandbox's whole life. Compiled once per boot by logon.cmd (csc, /target:winexe: no window). C# 5.
// Never stops the boot: every subcommand exits 0 and writes what happened to C:\AgentData\logs\logon-hit.txt.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

static class Program
{
    private const string SessionFile = @"C:\AgentLaunch\session.json";
    private const string LogonLog = @"C:\AgentData\logs\logon-hit.txt";

    static int Main(string[] args)
    {
        string command = args.Length > 0 ? args[0] : "";
        Dictionary<string, string> options = Options(args);
        try
        {
            switch (command)
            {
                case "cpu-cap":
                    CpuCapCommand(options);
                    break;
                case "page-file":
                    PageFileCommand(options);
                    break;
                case "memory-log":
                    MemoryLog.Run(Option(options, "dir", MemoryLog.DefaultFolder), options.ContainsKey("once"));
                    break;
                default:
                    Log("SandboxTools: unknown command '" + command + "' (cpu-cap, page-file, memory-log).");
                    break;
            }
        }
        catch (Exception e)
        {
            Log("SandboxTools " + command + ": " + e.Message);
        }
        return 0;
    }

    /// <summary>sandbox.cpuLimit: the caller (logon.cmd's cmd.exe) and everything it starts get a hard CPU cap.</summary>
    static void CpuCapCommand(Dictionary<string, string> options)
    {
        try
        {
            int percent = IntOption(options, "percent", 0);
            if (percent == 0)
            {
                percent = SessionNumber("cpuLimitPercent");
            }
            if (percent < 1 || percent >= 100)
            {
                return;
            }
            int pid = IntOption(options, "pid", 0);
            if (pid == 0)
            {
                pid = SandboxCpuCap.ParentProcessId();
            }
            SandboxCpuCap.Apply(pid, percent);
            Log("CPU capped at " + percent + "% of the PC (sandbox.cpuLimit): programs see " + SandboxCpuCap.UsableProcessors(Environment.ProcessorCount, percent) + " of " + Environment.ProcessorCount + " processors.");
        }
        catch (Exception e)
        {
            Log("CPU cap not applied (the sandbox runs uncapped): " + e.Message);
        }
    }

    /// <summary>sandbox.pageFileMb: the paging file at full size now, keeping 8 GB of the disk free.</summary>
    static void PageFileCommand(Dictionary<string, string> options)
    {
        try
        {
            int sizeMb = IntOption(options, "size-mb", 0);
            if (sizeMb == 0)
            {
                sizeMb = SessionNumber("pageFileMb");
            }
            if (sizeMb <= 0)
            {
                return;
            }
            sizeMb = SandboxPageFile.FitToDisk(sizeMb);
            SandboxPageFile.Set(sizeMb);
            Log("Paging file set to " + sizeMb + " MB, fixed (sandbox.pageFileMb).");
        }
        catch (Exception e)
        {
            Log("Paging file left as it is: " + e.Message);
        }
    }

    /// <summary>--name value pairs and --flag switches after the command.</summary>
    static Dictionary<string, string> Options(string[] args)
    {
        Dictionary<string, string> options = new Dictionary<string, string>();
        for (int i = 1; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--"))
            {
                continue;
            }
            string name = args[i].Substring(2);
            bool hasValue = i + 1 < args.Length && !args[i + 1].StartsWith("--");
            options[name] = hasValue ? args[++i] : "";
        }
        return options;
    }

    static string Option(Dictionary<string, string> options, string name, string fallback)
    {
        string value;
        return options.TryGetValue(name, out value) && value.Length > 0 ? value : fallback;
    }

    static int IntOption(Dictionary<string, string> options, string name, int fallback)
    {
        int value;
        return int.TryParse(Option(options, name, ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)
            ? value
            : fallback;
    }

    /// <summary>A top-level number in session.json (written by the host); 0 when it is missing or null.</summary>
    static int SessionNumber(string key)
    {
        string json = File.ReadAllText(SessionFile);
        Match m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(-?\\d+)");
        int value;
        return m.Success && int.TryParse(m.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)
            ? value
            : 0;
    }

    static void Log(string line)
    {
        try
        {
            File.AppendAllText(LogonLog, line + Environment.NewLine);
        }
        catch (IOException)
        {
            // Logging is best effort: the boot goes on.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }
}
