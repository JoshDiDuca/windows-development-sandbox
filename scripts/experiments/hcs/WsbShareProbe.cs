// Live folders, real-PC probe (PROTOTYPE, docs/design/hcs-live-folders.md, "PC test plan"). For the owner's PC only,
// run by hand from an elevated shell while Windows Sandbox (started by this tool) is open. C# 5; build:
//   csc.exe /nologo /r:System.Web.Extensions.dll /out:WsbShareProbe.exe WsbShareProbe.cs
// Verbs:
//   WsbShareProbe find                      read-only: every compute system (Id, SystemType, Owner, State) and which one
//                                           looks like Windows Sandbox (a running VirtualMachine with a Windows Sandbox
//                                           Owner, and the only one)
//   WsbShareProbe add <id> <name> <folder>  adds ONE read-only vSMB share (NoDirectmap) to that system, after `find`'s
//   WsbShareProbe remove <id> <name>        rules pass again for exactly that id; remove takes it away again
// Never terminates, pauses or otherwise changes the system. Share names must start with agentsbx- (never the names
// Windows Sandbox gives its own shares).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace AgentSandbox.Experiments
{
    public static class WsbShareProbe
    {
        private const uint WaitMs = 60000;
        private const uint GenericAll = 0x10000000;
        private const string ResourcePath = "VirtualMachine/Devices/VirtualSmb/Shares";
        /// <summary>The owner Windows Sandbox is reported to use (community table); `find` shows the real one first.</summary>
        private static readonly string[] SandboxOwners = new string[] { "Madrid" };
        private static readonly Regex ShareName = new Regex("^agentsbx-[0-9a-f]{8,32}$");
        private static readonly Regex Guid = new Regex("^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$");

        private static class NativeMethods
        {
            [DllImport("computecore.dll", ExactSpelling = true, SetLastError = true)]
            public static extern IntPtr HcsCreateOperation(IntPtr context, IntPtr callback);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern void HcsCloseOperation(IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern int HcsWaitForOperationResult(IntPtr operation, uint timeoutMs, out IntPtr resultDocument);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsEnumerateComputeSystems(string query, IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsOpenComputeSystem(string id, uint requestedAccess, out IntPtr computeSystem);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsModifyComputeSystem(IntPtr computeSystem, IntPtr operation, string configuration, IntPtr identity);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern void HcsCloseComputeSystem(IntPtr computeSystem);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr LocalFree(IntPtr mem);
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "find")
            {
                string id;
                Console.WriteLine(Find(out id));
                return id != null ? 0 : 1;
            }
            if ((args.Length == 4 && args[0] == "add") || (args.Length == 3 && args[0] == "remove"))
            {
                bool add = args[0] == "add";
                string found;
                string report = Find(out found);
                if (found == null || !string.Equals(found, args[1], StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine(report);
                    Console.WriteLine("Refused: " + args[1] + " is not the one running Windows Sandbox found above");
                    return 2;
                }
                if (!ShareName.IsMatch(args[2]))
                {
                    Console.WriteLine("Refused: the share name must look like agentsbx-<8 to 32 hex digits>");
                    return 2;
                }
                string settings = "{\"Name\":\"" + args[2] + "\"}";
                if (add)
                {
                    string folder = args[3].TrimEnd('\\');
                    if (!Regex.IsMatch(folder, "^[A-Za-z]:\\\\[^<>\"|?*:/~\\x00-\\x1f]+$") || Path.GetFullPath(folder) != folder ||
                        new DriveInfo(folder.Substring(0, 1)).DriveType != DriveType.Fixed)
                    {
                        Console.WriteLine("Refused: give the full long path of a folder on a fixed local drive");
                        return 2;
                    }
                    DirectoryInfo dir = new DirectoryInfo(folder);
                    if (!dir.Exists || dir.Parent == null)
                    {
                        Console.WriteLine("Refused: share an existing folder that is not a drive");
                        return 2;
                    }
                    for (DirectoryInfo d = dir; d != null && d.Parent != null; d = d.Parent)
                    {
                        if ((d.Attributes & FileAttributes.ReparsePoint) != 0)
                        {
                            Console.WriteLine("Refused: a link on the way: " + d.FullName);
                            return 2;
                        }
                    }
                    settings = "{\"Name\":\"" + args[2] + "\",\"Path\":" + new JavaScriptSerializer().Serialize(folder) +
                        ",\"Options\":{\"ReadOnly\":true,\"ShareRead\":true,\"CacheIo\":true,\"PseudoOplocks\":true,\"NoDirectmap\":true}}";
                }
                string request = "{\"ResourcePath\":\"" + ResourcePath + "\",\"RequestType\":\"" + (add ? "Add" : "Remove") + "\",\"Settings\":" + settings + "}";
                Console.WriteLine("request: " + request);
                string result;
                int hr = Modify(found, request, out result);
                Console.WriteLine("HcsModifyComputeSystem 0x" + hr.ToString("X8") + " " + result);
                return hr == 0 ? 0 : 1;
            }
            Console.WriteLine("Usage: WsbShareProbe find | add <id> <agentsbx-name> <folder> | remove <id> <agentsbx-name>");
            return 2;
        }

        /// <summary>A report of every system; `id` is the Windows Sandbox one when exactly one matches the rules.</summary>
        private static string Find(out string id)
        {
            id = null;
            string json;
            int hr = Run(delegate(IntPtr op) { return NativeMethods.HcsEnumerateComputeSystems(null, op); }, out json);
            StringBuilder report = new StringBuilder();
            report.AppendLine("HcsEnumerateComputeSystems 0x" + hr.ToString("X8"));
            if (hr != 0)
            {
                report.AppendLine(json);
                return report.ToString();
            }
            ArrayList systems = new JavaScriptSerializer().Deserialize<ArrayList>(json);
            List<string> matches = new List<string>();
            foreach (object o in systems)
            {
                Dictionary<string, object> s = o as Dictionary<string, object>;
                if (s == null)
                {
                    continue;
                }
                string sid = Field(s, "Id");
                string type = Field(s, "SystemType");
                string owner = Field(s, "Owner");
                string state = Field(s, "State");
                report.AppendLine("  " + sid + "  type=" + type + "  owner=" + owner + "  state=" + state + "  runtimeId=" + Field(s, "RuntimeId"));
                if (type == "VirtualMachine" && state == "Running" && Array.IndexOf(SandboxOwners, owner) >= 0 && Guid.IsMatch(sid))
                {
                    matches.Add(sid);
                }
            }
            if (matches.Count == 1)
            {
                id = matches[0];
                report.AppendLine("Windows Sandbox: " + id);
            }
            else
            {
                report.AppendLine("Windows Sandbox: " + matches.Count + " candidates (exactly one is required)");
            }
            return report.ToString();
        }

        private static string Field(Dictionary<string, object> s, string key)
        {
            object value;
            return s.TryGetValue(key, out value) && value != null ? value.ToString() : "";
        }

        private delegate int Begin(IntPtr operation);

        private static int Run(Begin begin, out string result)
        {
            result = "";
            IntPtr operation = NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
            if (operation == IntPtr.Zero)
            {
                return Marshal.GetHRForLastWin32Error();
            }
            try
            {
                int hr = begin(operation);
                if (hr != 0)
                {
                    return hr;
                }
                IntPtr doc = IntPtr.Zero;
                hr = NativeMethods.HcsWaitForOperationResult(operation, WaitMs, out doc);
                if (doc != IntPtr.Zero)
                {
                    try
                    {
                        result = Marshal.PtrToStringUni(doc);
                    }
                    finally
                    {
                        NativeMethods.LocalFree(doc);
                    }
                }
                return hr;
            }
            finally
            {
                NativeMethods.HcsCloseOperation(operation);
            }
        }

        private static int Modify(string id, string request, out string result)
        {
            result = "";
            IntPtr system;
            int hr = NativeMethods.HcsOpenComputeSystem(id, GenericAll, out system);
            if (hr != 0)
            {
                return hr;
            }
            try
            {
                return Run(delegate(IntPtr op) { return NativeMethods.HcsModifyComputeSystem(system, op, request, IntPtr.Zero); }, out result);
            }
            finally
            {
                NativeMethods.HcsCloseComputeSystem(system);
            }
        }
    }
}
