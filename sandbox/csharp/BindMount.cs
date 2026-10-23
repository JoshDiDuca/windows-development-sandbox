// Live folders, guest side (docs/design/hcs-live-folders.md): shows a vSMB share the host added to this running sandbox
// at C:\Workspace\<name> with the bind filter, the way Windows Sandbox's own guest agent shows .wsb mapped folders, so
// tools see a plain folder (not a link). Run by the session daemon (an administrator) by path; compiled inside the
// sandbox with the .NET Framework csc.exe (C# 5). Verbs (exit 0 = done, 1 = failed, 2 = refused, 3 = no such share yet):
//   BindMount map <C:\Workspace\name> <agentsbx-share> [rw]   the folder shows the share (read-only unless rw)
//   BindMount unmap <C:\Workspace\name>                       removes that mapping again
//   BindMount mapped <C:\Workspace\name>                      exit 0 when the bind filter has a mapping there, else 4
// Only share names with this tool's prefix and only C:\Workspace\<plain name> (no dots or spaces, so no "..", "foo."
// or "foo " aliases of other folders), so it can never re-point a folder Windows Sandbox mapped. Flag names and the
// BfGetMappings layout: go-winio pkg/bindfilter (vendored in microsoft/hcsshim) and BuildXL's NativeContainerUtilities.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class BindMount
{
    private const string VsmbRoot = "\\\\?\\GLOBALROOT\\Device\\vmsmb\\VSMB-{dcc079ae-60ba-4d07-847c-3493609c0870}\\";
    private const uint ReadOnlyMapping = 0x1;
    private const uint NoMultipleTargets = 0x40;
    private const uint GetMappingsVolume = 0x1;
    /// <summary>
    /// A share that has not arrived: ERROR_NOT_FOUND (seen in a Windows Sandbox, 2026-10-23, with C:\Workspace there) or
    /// ERROR_FILE_NOT_FOUND (what the design note recorded; also the answer when C:\Workspace itself is missing).
    /// </summary>
    private const int NotFound = unchecked((int)0x80070490);
    private const int FileNotFound = unchecked((int)0x80070002);
    private const int ExitOk = 0;
    private const int ExitFailed = 1;
    private const int ExitRefused = 2;
    private const int ExitNoShare = 3;
    private const int ExitNotMapped = 4;
    private static readonly Regex ShareName = new Regex("^agentsbx-[0-9a-f]{8,32}$");
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

    static int Main(string[] args)
    {
        if ((args.Length == 3 || args.Length == 4) && args[0] == "map")
        {
            if (!GuestFolder.IsMatch(args[1]) || !ShareName.IsMatch(args[2]) || (args.Length == 4 && args[3] != "rw"))
            {
                Console.WriteLine("Refused: map C:\\Workspace\\<plain name> to an agentsbx- share only");
                return ExitRefused;
            }
            if (Directory.Exists(args[1]) || File.Exists(args[1]))
            {
                Console.WriteLine("Refused: " + args[1] + " exists already");
                return ExitRefused;
            }
            uint flags = NoMultipleTargets | (args.Length == 4 ? 0u : ReadOnlyMapping);
            int hr = NativeMethods.BfSetupFilter(IntPtr.Zero, flags, args[1], VsmbRoot + args[2] + "\\", IntPtr.Zero, 0);
            Console.WriteLine("BfSetupFilter 0x" + hr.ToString("X8"));
            return hr == 0 ? ExitOk : (hr == NotFound || hr == FileNotFound ? ExitNoShare : ExitFailed);
        }
        if (args.Length == 2 && (args[0] == "unmap" || args[0] == "mapped"))
        {
            if (!GuestFolder.IsMatch(args[1]))
            {
                Console.WriteLine("Refused: only C:\\Workspace\\<plain name>");
                return ExitRefused;
            }
            if (args[0] == "mapped")
            {
                bool found;
                int listed = HasMapping(args[1], out found);
                Console.WriteLine("BfGetMappings 0x" + listed.ToString("X8") + (found ? " mapped" : " not mapped"));
                return listed != 0 ? ExitFailed : (found ? ExitOk : ExitNotMapped);
            }
            int hr = NativeMethods.BfRemoveMapping(IntPtr.Zero, args[1]);
            Console.WriteLine("BfRemoveMapping 0x" + hr.ToString("X8"));
            return hr == 0 ? ExitOk : ExitFailed;
        }
        Console.WriteLine("Usage: BindMount map <folder> <share> [rw] | unmap <folder> | mapped <folder>");
        return ExitRefused;
    }

    /// <summary>Whether the bind filter has a mapping whose virtual root is `folder` (BfGetMappings on C:).</summary>
    private static int HasMapping(string folder, out bool found)
    {
        found = false;
        uint size = 1024 * 1024;
        byte[] buffer = new byte[size];
        int hr = NativeMethods.BfGetMappings(GetMappingsVolume, IntPtr.Zero, "C:\\", IntPtr.Zero, ref size, buffer);
        if (hr != 0 || size < 12)
        {
            return hr != 0 ? hr : ExitFailed;
        }
        uint count = BitConverter.ToUInt32(buffer, 8);
        string wanted = "\\" + folder.Substring(3).TrimEnd('\\');
        for (int i = 0; i < count && 12 + (i * 20) + 20 <= buffer.Length; i++)
        {
            int entry = 12 + (i * 20);
            uint length = BitConverter.ToUInt32(buffer, entry);
            uint offset = BitConverter.ToUInt32(buffer, entry + 4);
            if (offset + length > buffer.Length)
            {
                continue;
            }
            string root = Encoding.Unicode.GetString(buffer, (int)offset, (int)length).TrimEnd('\\');
            if (root.EndsWith(wanted, StringComparison.OrdinalIgnoreCase))
            {
                found = true;
            }
        }
        return 0;
    }
}
