// Caps a process and everything it starts at a share of the PC's CPU (SandboxTools cpu-cap). Windows Sandbox has no
// CPU setting and gets every processor; a job object with a hard CPU-rate cap holds logon.cmd and all it starts, and
// limits them to as many processors as the cap allows, so programs that count processors (cargo, .NET, ninja, nproc)
// plan for what they may use, as on a PC of that size. C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SandboxCpuCap
{
    private const int JobObjectBasicLimitInformation = 2;
    private const int JobObjectCpuRateControlInformation = 15;
    private const uint LimitAffinity = 0x00000010;
    /// <summary>Affinity masks hold 64 processors; with more, only the rate cap applies.</summary>
    private const int MaxMaskProcessors = 64;
    private const uint CpuRateEnable = 0x1;
    private const uint CpuRateHardCap = 0x4;
    // What AssignProcessToJobObject needs.
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessSetQuota = 0x0100;
    // The rate is in 1/100 % of all processors.
    private const int RateUnitsPerPercent = 100;

    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION.
    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRate
    {
        public uint ControlFlags;
        public uint Rate;
    }

    // JOBOBJECT_BASIC_LIMIT_INFORMATION.
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    private const uint SnapshotProcesses = 0x2;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    // PROCESSENTRY32W.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRate info, int length);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")]
        public static extern bool SetBasicLimit(IntPtr job, int infoClass, ref BasicLimit info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
    }

    /// <summary>The process that started this one (logon.cmd's cmd.exe). Throws when it cannot be found.</summary>
    public static int ParentProcessId()
    {
        int self = System.Diagnostics.Process.GetCurrentProcess().Id;
        IntPtr snapshot = NativeMethods.CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == InvalidHandle)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            ProcessEntry entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            for (bool more = NativeMethods.Process32FirstW(snapshot, ref entry); more; more = NativeMethods.Process32NextW(snapshot, ref entry))
            {
                if (entry.ProcessId == self)
                {
                    return (int)entry.ParentProcessId;
                }
            }
        }
        finally
        {
            NativeMethods.CloseHandle(snapshot);
        }
        throw new InvalidOperationException("the parent process was not found.");
    }

    /// <summary>
    /// How many processors a cap of percent % allows (at least 2), the same count the daemon gives NUMBER_OF_PROCESSORS.
    /// </summary>
    public static int UsableProcessors(int processors, int percent)
    {
        return Math.Max(2, Math.Min(processors, processors * percent / 100));
    }

    /// <summary>The job's processes run on the first UsableProcessors processors; nothing changes when that is all.</summary>
    private static void LimitProcessors(IntPtr job, int percent)
    {
        int processors = Environment.ProcessorCount;
        int usable = UsableProcessors(processors, percent);
        if (processors > MaxMaskProcessors || usable >= processors)
        {
            return;
        }
        BasicLimit limit = new BasicLimit();
        limit.LimitFlags = LimitAffinity;
        limit.Affinity = new UIntPtr((1UL << usable) - 1);
        // Best effort: without it the rate cap still holds, programs only count more processors than they get.
        NativeMethods.SetBasicLimit(job, JobObjectBasicLimitInformation, ref limit, Marshal.SizeOf(typeof(BasicLimit)));
    }

    /// <summary>Puts process pid in a new job with a hard cap of percent % of all processors. Throws on failure.</summary>
    public static void Apply(int pid, int percent)
    {
        IntPtr job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CpuRate rate = new CpuRate();
        rate.ControlFlags = CpuRateEnable | CpuRateHardCap;
        rate.Rate = (uint)(percent * RateUnitsPerPercent);
        if (!NativeMethods.SetInformationJobObject(job, JobObjectCpuRateControlInformation, ref rate, Marshal.SizeOf(typeof(CpuRate))))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        LimitProcessors(job, percent);
        IntPtr process = NativeMethods.OpenProcess(ProcessSetQuota | ProcessTerminate, false, pid);
        if (process == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            if (!NativeMethods.AssignProcessToJobObject(job, process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
        // The job's handle is left to close with this process: the job lives on while any process in it runs.
    }
}
