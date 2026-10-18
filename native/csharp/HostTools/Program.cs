// HostTools.exe: what the host side asks of Windows without PowerShell. Built on first use by host/native.ts (csc).
//   keep-awake --owner-pid N    this PC stays awake until process N ends (sandbox.keepAwake)
//   stop-events --since <iso>   the Windows events since then that can end a sandbox, as JSON (host/life)
//   memory-status               this PC's RAM and commit (what a sandbox's memory is charged against), as JSON
//   hide-window --wait S        hides the sandbox window once it appears; prints the hidden handles as JSON
//   show-window --handles a,b   shows those windows (else any sandbox window); prints how many
//   user-path --add|--remove D  D first on, or off, your PATH; exit 3 when PATH would be too long
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Text;

static class Program
{
    private const int MaxEventsPerQuery = 100;
    private const int MaxDetail = 390;
    private const int MaxResourceDetail = 1500;

    static int Main(string[] args)
    {
        string command = args.Length > 0 ? args[0] : "";
        Dictionary<string, string> options = Options(args);
        string value;
        switch (command)
        {
            case "keep-awake":
                int pid;
                if (!options.TryGetValue("owner-pid", out value) || !int.TryParse(value, out pid))
                {
                    return Usage();
                }
                KeepAwake(pid);
                return 0;
            case "stop-events":
                DateTime since;
                if (!options.TryGetValue("since", out value) || !DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out since))
                {
                    return Usage();
                }
                Console.Out.Write(StopEventsJson(since));
                return 0;
            case "memory-status":
                try
                {
                    Console.Out.Write(AgentSandbox.HostMemory.Json());
                    return 0;
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e.Message);
                    return 1;
                }
            case "hide-window":
                int wait;
                if (!options.TryGetValue("wait", out value) || !int.TryParse(value, out wait))
                {
                    return Usage();
                }
                Console.Out.Write("[" + string.Join(",", AgentSandbox.Win.Hide(wait)) + "]");
                return 0;
            case "show-window":
                List<long> handles = new List<long>();
                if (options.TryGetValue("handles", out value))
                {
                    foreach (string part in value.Split(','))
                    {
                        long handle;
                        if (long.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out handle))
                        {
                            handles.Add(handle);
                        }
                    }
                }
                Console.Out.Write(AgentSandbox.Win.Show(handles).ToString(CultureInfo.InvariantCulture));
                return 0;
            case "user-path":
                bool add = options.TryGetValue("add", out value);
                if (!add && !options.TryGetValue("remove", out value))
                {
                    return Usage();
                }
                try
                {
                    return AgentSandbox.UserPath.Edit(value, add);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e.Message);
                    return 1;
                }
            default:
                return Usage();
        }
    }

    static int Usage()
    {
        Console.Error.WriteLine("Usage: HostTools keep-awake --owner-pid N | stop-events --since <ISO time> | memory-status | hide-window --wait S | show-window [--handles a,b] | user-path --add|--remove <folder>");
        return 2;
    }

    /// <summary>--name value pairs after the command.</summary>
    static Dictionary<string, string> Options(string[] args)
    {
        Dictionary<string, string> options = new Dictionary<string, string>();
        for (int i = 1; i + 1 < args.Length; i += 2)
        {
            if (args[i].StartsWith("--"))
            {
                options[args[i].Substring(2)] = args[i + 1];
            }
        }
        return options;
    }

    static void KeepAwake(int ownerPid)
    {
        AgentSandbox.Power.StayAwake();
        try
        {
            using (Process owner = Process.GetProcessById(ownerPid))
            {
                owner.WaitForExit();
            }
        }
        catch (ArgumentException)
        {
            // The owner has ended already.
        }
    }

    /// <summary>Restarts and shutdowns, power loss, sleep, low memory, this PC's blue screens, the sandbox crashing.</summary>
    static string StopEventsJson(DateTime sinceUtc)
    {
        string time = "TimeCreated[@SystemTime>='" + sinceUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + "']";
        string[][] queries =
        {
            new[] { "System", "*[System[(EventID=1074 or EventID=6008 or EventID=41 or EventID=42 or EventID=2004) and " + time + "]]" },
            new[] { "System", "*[System[Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and EventID=1001 and " + time + "]]" },
            new[] { "Microsoft-Windows-Hyper-V-Worker-Admin", "*[System[(EventID=18590 or EventID=40001) and " + time + "]]" },
            // Hardware errors Windows reported (WHEA: CPU, memory, bus, disk).
            new[] { "System", "*[System[Provider[@Name='Microsoft-Windows-WHEA-Logger'] and (EventID=17 or EventID=18 or EventID=19 or EventID=47) and " + time + "]]" },
            // Any error or critical event of the Hyper-V worker and compute services (the VM's memory, start and stop).
            new[] { "Microsoft-Windows-Hyper-V-Worker-Admin", "*[System[(Level=1 or Level=2) and " + time + "]]" },
            new[] { "Microsoft-Windows-Hyper-V-Compute-Admin", "*[System[(Level=1 or Level=2) and " + time + "]]" },
            // A crash report of the programs that hold the VM (kept only when it names one of them, see Detail).
            new[] { "Application", "*[System[(EventID=1000 or EventID=1001) and " + time + "]]" },
        };
        List<string> items = new List<string>();
        foreach (string[] query in queries)
        {
            try
            {
                ReadEvents(query[0], query[1], items, query[0] == "Application");
            }
            catch (EventLogException)
            {
                // A log this PC does not have, or no access: nothing to add.
            }
            catch (UnauthorizedAccessException)
            {
                // Same.
            }
        }
        return "[" + string.Join(",", items) + "]";
    }

    /// <summary>The newest events first, at most 100 per query, as JSON objects { at, id, provider, process }.</summary>
    static void ReadEvents(string log, string xpath, List<string> items, bool onlyVmPrograms)
    {
        EventLogQuery query = new EventLogQuery(log, PathType.LogName, xpath);
        query.ReverseDirection = true;
        using (EventLogReader reader = new EventLogReader(query))
        {
            for (int n = 0; n < MaxEventsPerQuery; n++)
            {
                using (EventRecord record = reader.ReadEvent())
                {
                    if (record == null)
                    {
                        return;
                    }
                    DateTime at = record.TimeCreated.HasValue ? record.TimeCreated.Value.ToUniversalTime() : DateTime.UtcNow;
                    string detail = Detail(record);
                    if (onlyVmPrograms && !MentionsVmProgram(detail))
                    {
                        continue;
                    }
                    items.Add(
                        "{\"at\":" + Json(at.ToString("o", CultureInfo.InvariantCulture)) +
                        ",\"id\":" + record.Id.ToString(CultureInfo.InvariantCulture) +
                        ",\"provider\":" + Json(record.ProviderName ?? "") +
                        ",\"process\":" + Json(detail) + "}");
                }
            }
        }
    }

    /// <summary>
    /// What an event says beyond its id: the program that asked for a restart (1074), else its message start (the
    /// resource-exhaustion event 2004 lists the biggest memory users, so it gets more room). Not for the plain power events.
    /// </summary>
    static string Detail(EventRecord record)
    {
        if (record.Id == 1074)
        {
            return record.Properties.Count > 0 ? Convert.ToString(record.Properties[0].Value, CultureInfo.InvariantCulture) ?? "" : "";
        }
        if (record.Id == 41)
        {
            // Kernel-Power 41 carries the stop code of a blue screen (0 when there was none: a freeze or power loss).
            return record.Properties.Count > 0 ? "BugcheckCode " + Convert.ToString(record.Properties[0].Value, CultureInfo.InvariantCulture) : "";
        }
        if (record.Id == 42 || record.Id == 6008)
        {
            return "";
        }
        string message;
        try
        {
            message = record.FormatDescription() ?? "";
        }
        catch (EventLogException)
        {
            message = "";
        }
        int max = record.Id == 2004 ? MaxResourceDetail : MaxDetail;
        return message.Substring(0, Math.Min(max, message.Length));
    }

    /// <summary>Whether an application crash report names a program that runs the sandbox's VM.</summary>
    static bool MentionsVmProgram(string detail)
    {
        string lower = detail.ToLowerInvariant();
        return lower.Contains("vmwp.exe") || lower.Contains("vmmem") || lower.Contains("vmcompute") || lower.Contains("windowssandbox");
    }

    /// <summary>A JSON string literal.</summary>
    static string Json(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            switch (c)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
