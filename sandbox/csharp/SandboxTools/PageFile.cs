// Sets the size of the sandbox's paging file at once, with no restart (SandboxTools page-file). Windows Sandbox starts
// with about 1 GB, and Windows growing it under parallel builds crashed the sandbox (0x1A); a fixed size never grows. C# 5.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class SandboxPageFile
{
    private const int SeCreatePagefilePrivilege = 15;
    private const long BytesPerMb = 1048576L;
    // The same name Windows uses at startup; for the existing file the call changes the size in place.
    private const string PagingFile = @"\??\C:\pagefile.sys";
    // Kept free on the sandbox's disk for everything else, and the smallest size worth setting.
    private const long KeepFreeMb = 8192;
    private const int MinimumMb = 1024;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private class MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
        public MemoryStatus() { Length = (uint)Marshal.SizeOf(typeof(MemoryStatus)); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx([In, Out] MemoryStatus buffer);

    /// <summary>Returns the guest's assigned physical RAM, not the host's RAM.</summary>
    public static long TotalMemoryMb()
    {
        MemoryStatus status = new MemoryStatus();
        if (!GlobalMemoryStatusEx(status)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return (long)(status.TotalPhys / (ulong)BytesPerMb);
    }

    /// <summary>Fixed paging file size capped by assigned RAM and available C: disk while keeping 8 GB free.</summary>
    public static int AutoSizeMb(long guestRamMb, long availableFreeBytes)
    {
        long diskMb = availableFreeBytes / BytesPerMb - KeepFreeMb;
        long sizeMb = Math.Min(guestRamMb, diskMb);
        return sizeMb < MinimumMb ? 0 : (int)(sizeMb / 1024 * 1024);
    }

    // UNICODE_STRING. The marshaller copies Buffer to native memory for the length of the call.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NtString
    {
        public ushort Length;
        public ushort MaximumLength;
        public string Buffer;
    }

    private static class NativeMethods
    {
        [DllImport("ntdll.dll")]
        public static extern int RtlAdjustPrivilege(int privilege, bool enable, bool currentThread, out bool wasEnabled);

        [DllImport("ntdll.dll")]
        public static extern int NtCreatePagingFile(ref NtString path, ref long minimumBytes, ref long maximumBytes, uint priority);

        [DllImport("ntdll.dll")]
        public static extern int RtlNtStatusToDosError(int status);
    }

    /// <summary>sizeMb, or less so 8 GB of C: stays free. Throws when that leaves less than 1 GB.</summary>
    public static int FitToDisk(int sizeMb)
    {
        long freeMb = new DriveInfo("C").AvailableFreeSpace / BytesPerMb;
        int size = (int)Math.Min(sizeMb, freeMb - KeepFreeMb);
        if (size < MinimumMb)
        {
            throw new InvalidOperationException("too little free disk.");
        }
        return size;
    }

    /// <summary>Makes C:\pagefile.sys sizeMb, fixed (it never grows). Throws with Windows' reason on failure.</summary>
    public static void Set(int sizeMb)
    {
        bool wasEnabled;
        Check(NativeMethods.RtlAdjustPrivilege(SeCreatePagefilePrivilege, true, false, out wasEnabled));
        NtString name = new NtString();
        name.Length = (ushort)(PagingFile.Length * 2);
        name.MaximumLength = (ushort)(PagingFile.Length * 2 + 2);
        name.Buffer = PagingFile;
        long minimum = sizeMb * BytesPerMb;
        long maximum = minimum;
        Check(NativeMethods.NtCreatePagingFile(ref name, ref minimum, ref maximum, 0));
    }

    private static void Check(int status)
    {
        if (status != 0)
        {
            throw new Win32Exception(NativeMethods.RtlNtStatusToDosError(status));
        }
    }
}
