// Guest side of live folders (PROTOTYPE, docs/design/hcs-live-folders.md). Runs INSIDE Windows Sandbox (or our utility
// VM) as an administrator. Shows a vSMB share at a folder with the bind filter, the way Windows Sandbox's own guest
// agent (CmAgent) shows the .wsb mapped folders. C# 5; build:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:BindMount.exe BindMount.cs
// Verbs:
//   BindMount list                                  the bind filter's mappings on C: (BfGetMappings), read-only
//   BindMount map <folder> <shareName> [rw]         C:\...\<folder> shows \\?\GLOBALROOT\Device\vmsmb\VSMB-{...}\<shareName>
//   BindMount unmap <folder>                        removes that mapping again (only one this tool made)
// Only share names with this tool's prefix (agentsbx-) can be mapped, and only to C:\Workspace\<plain name>, so the
// prototype cannot re-point a folder Windows Sandbox mapped.
// Struct layout of BfGetMappings and the flags: go-winio pkg/bindfilter (vendored in microsoft/hcsshim) and BuildXL's
// NativeContainerUtilities.cs.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace AgentSandbox.Experiments
{
    public static class BindMount
    {
        private const string VsmbRoot = "\\\\?\\GLOBALROOT\\Device\\vmsmb\\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\\";
        private const uint ReadOnlyMapping = 0x1;
        private const uint NoMultipleTargets = 0x40;
        private const uint GetMappingsVolume = 0x1;
        private const int ExitOk = 0;
        private const int ExitFailed = 1;
        private const int ExitUsage = 2;
        private static readonly Regex ShareName = new Regex("^agentsbx-[0-9a-f]{8,32}$");
        /// <summary>C:\Workspace\<name> only: no dots or spaces, so no "..", "foo." or "foo " aliases of other folders.</summary>
        private static readonly Regex GuestFolder = new Regex("^C:\\\\Workspace\\\\[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.IgnoreCase);

        private static class NativeMethods
        {
            [DllImport("bindfltapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int BfSetupFilter(IntPtr job, uint flags, string virtRoot, string target, IntPtr exceptions, uint exceptionCount);

            [DllImport("bindfltapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int BfRemoveMapping(IntPtr job, string virtRoot);

            [DllImport("bindfltapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
            public static extern int BfGetMappings(uint flags, IntPtr job, string virtRoot, IntPtr sid, ref uint bufferSize, byte[] buffer);
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "list")
            {
                return List();
            }
            if ((args.Length == 3 || args.Length == 4) && args[0] == "map")
            {
                if (!GuestFolder.IsMatch(args[1]) || !ShareName.IsMatch(args[2]))
                {
                    Console.WriteLine("Refused: map C:\\Workspace\\<plain name> to an agentsbx- share only");
                    return ExitUsage;
                }
                uint flags = NoMultipleTargets;
                if (args.Length == 3 || args[3] != "rw")
                {
                    flags |= ReadOnlyMapping;
                }
                int hr = NativeMethods.BfSetupFilter(IntPtr.Zero, flags, args[1], VsmbRoot + args[2] + "\\", IntPtr.Zero, 0);
                Console.WriteLine("BfSetupFilter 0x" + hr.ToString("X8"));
                return hr == 0 ? ExitOk : ExitFailed;
            }
            if (args.Length == 3 && args[0] == "map-existing")
            {
                // Manual test only (Test-LiveGuest.ps1): one of Windows Sandbox's own shares (64 hex digits), read-only, at
                // a new C:\Workspace\<plain name>. The shipped helper (sandbox\csharp\BindMount.cs) has no such verb.
                if (!GuestFolder.IsMatch(args[1]) || !Regex.IsMatch(args[2], "^[0-9a-f]{64}$"))
                {
                    Console.WriteLine("Refused: map-existing C:\\Workspace\\<plain name> <64 hex digits>");
                    return ExitUsage;
                }
                int hr = NativeMethods.BfSetupFilter(IntPtr.Zero, NoMultipleTargets | ReadOnlyMapping, args[1], VsmbRoot + args[2] + "\\", IntPtr.Zero, 0);
                Console.WriteLine("BfSetupFilter 0x" + hr.ToString("X8"));
                return hr == 0 ? ExitOk : ExitFailed;
            }
            if (args.Length == 2 && args[0] == "unmap")
            {
                if (!GuestFolder.IsMatch(args[1]))
                {
                    Console.WriteLine("Refused: only C:\\Workspace\\<plain name>");
                    return ExitUsage;
                }
                int hr = NativeMethods.BfRemoveMapping(IntPtr.Zero, args[1]);
                Console.WriteLine("BfRemoveMapping 0x" + hr.ToString("X8"));
                return hr == 0 ? ExitOk : ExitFailed;
            }
            Console.WriteLine("Usage: BindMount list | map <folder> <shareName> [rw] | unmap <folder>");
            return ExitUsage;
        }

        private static int List()
        {
            uint size = 1024 * 1024;
            byte[] buffer = new byte[size];
            int hr = NativeMethods.BfGetMappings(GetMappingsVolume, IntPtr.Zero, "C:\\", IntPtr.Zero, ref size, buffer);
            if (hr != 0 || size < 12)
            {
                Console.WriteLine("BfGetMappings 0x" + hr.ToString("X8"));
                return ExitFailed;
            }
            uint count = BitConverter.ToUInt32(buffer, 8);
            for (int i = 0; i < count; i++)
            {
                int entry = 12 + (i * 20);
                uint flags = BitConverter.ToUInt32(buffer, entry + 8);
                uint targets = BitConverter.ToUInt32(buffer, entry + 12);
                uint targetsAt = BitConverter.ToUInt32(buffer, entry + 16);
                Console.WriteLine("flags 0x" + flags.ToString("X") + "  " + Text(buffer, BitConverter.ToUInt32(buffer, entry + 4), BitConverter.ToUInt32(buffer, entry)));
                for (int t = 0; t < targets; t++)
                {
                    int target = (int)targetsAt + (t * 8);
                    Console.WriteLine("    -> " + Text(buffer, BitConverter.ToUInt32(buffer, target + 4), BitConverter.ToUInt32(buffer, target)));
                }
            }
            return ExitOk;
        }

        private static string Text(byte[] buffer, uint offset, uint length)
        {
            return Encoding.Unicode.GetString(buffer, (int)offset, (int)length);
        }
    }
}
