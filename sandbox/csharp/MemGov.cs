// memgov.exe: the Windows side of the sandbox's memory governor (src/guest/governor). One long-running process the
// daemon talks to over stdin/stdout, so the decisions stay in TypeScript and only the Win32 calls live here. C# 5.
//
//   stdout, a JSON line every --interval seconds (default 2):
//     {"ramTotalMb":..,"ramAvailMb":..,"commitLimitMb":..,"commitAvailMb":..,"procs":[{"pid":..,"name":"rustc","mb":..,"prio":"normal"}]}
//     procs = the processes in the agents' job (the job ptyhost makes for everything the agents start), nothing else.
//     gateHeld = the build programs the memory gate holds right now (0 without a gate).
//   serve [--interval s] [--gate growthMb:windowMs:releaseMs:maxHoldMs --gate-names a,b,c]
//     With --gate, the memory gate (see GateLoop) also writes event lines on stdout:
//     {"event":"gate","kind":"ready|off|trip|hold|release","at":<ms since 1970 UTC>, ...}
//     Without --gate it never touches the job's completion port and writes no event.
//   stdin, one command per line:
//     priority <pid> <idle|below|normal>   lowers (or restores) the priority of a process in that job
//     iopriority <pid> <verylow|low|normal>  the disk queue priority of a process in that job
//     suspend <pid> <ms>                   pauses a process in that job, resumes it after ms (at most 30000)
//     exit
//
// It only ever touches processes that are in the agents' job, never itself, and resumes everything it paused when it
// ends or when the daemon goes away (stdin closes).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class MemGov
{
    private const string AgentJobName = "Local\\AgentSandboxAgentsJob";
    private const double BytesPerMb = 1024.0 * 1024.0;
    private const int MaxProcesses = 1024;
    private const int MaxSuspendMs = 30000;
    private const uint JobObjectQuery = 0x0004;
    private const int JobObjectBasicProcessIdList = 3;
    private const uint ProcessQueryLimited = 0x1000;
    private const uint ProcessSetInformation = 0x0200;
    private const uint ProcessSuspendResume = 0x0800;
    private const uint IdleClass = 0x00000040;
    private const uint BelowNormalClass = 0x00004000;
    private const uint NormalClass = 0x00000020;
    // The throttle job: compilers join it from the governor's step 2; its CPU cap follows the dial.
    private const string ThrottleJobName = "Local\\AgentSandboxBuildThrottle";
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessSetQuota = 0x0100;
    private const int JobObjectCpuRateControlInformation = 15;
    private const uint CpuRateEnable = 0x1;
    private const uint CpuRateHardCap = 0x4;
    private const int ProcessMemoryPriorityClass = 0;
    private const uint MemoryPriorityLow = 2;
    private const uint MemoryPriorityNormal = 5;
    // NtSetInformationProcess(ProcessIoPriority): IO_PRIORITY_HINT VeryLow = 0, Low = 1, Normal = 2.
    private const int ProcessIoPriority = 33;
    private const int IoPriorityVeryLow = 0;
    private const int IoPriorityLow = 1;
    private const int IoPriorityNormal = 2;
    // The memory gate: a notification limit on the agents' job, reported through a completion port.
    private const uint JobObjectSetAttributes = 0x0002;
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const int JobObjectNotificationLimitInformation = 12;
    private const int JobObjectLimitViolationInformation = 13;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobMsgNewProcess = 6;
    private const uint JobMsgExitProcess = 7;
    private const uint JobMsgAbnormalExitProcess = 8;
    private const uint JobMsgNotificationLimit = 11;
    private const uint GatePollMs = 100;
    private const int GateTickMs = 500;
    private const int GateRearmStepMb = 64;
    private const int ErrorAccessDenied = 5;
    private const int MaxTripList = 64;
    private const int MaxGateNames = 64;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
    private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    // JOBOBJECT_ASSOCIATE_COMPLETION_PORT.
    [StructLayout(LayoutKind.Sequential)]
    private struct CompletionPortLink
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    // JOBOBJECT_NOTIFICATION_LIMIT_INFORMATION (48 bytes on x64).
    [StructLayout(LayoutKind.Sequential)]
    private struct NotificationLimit
    {
        public ulong IoReadBytesLimit;
        public ulong IoWriteBytesLimit;
        public long PerJobUserTimeLimit;
        public ulong JobMemoryLimit;
        public int RateControlTolerance;
        public int RateControlToleranceInterval;
        public uint LimitFlags;
    }

    // JOBOBJECT_LIMIT_VIOLATION_INFORMATION (80 bytes on x64).
    [StructLayout(LayoutKind.Sequential)]
    private struct LimitViolation
    {
        public uint LimitFlags;
        public uint ViolationLimitFlags;
        public ulong IoReadBytes;
        public ulong IoReadBytesLimit;
        public ulong IoWriteBytes;
        public ulong IoWriteBytesLimit;
        public long PerJobUserTime;
        public long PerJobUserTimeLimit;
        public ulong JobMemory;
        public ulong JobMemoryLimit;
        public int RateControlTolerance;
        public int RateControlToleranceLimit;
    }

    private sealed class GateSettings
    {
        public int GrowthMb;
        public int WindowMs;
        public int ReleaseMs;
        public int MaxHoldMs;
        public HashSet<string> Names;
    }

    /// <summary>A process the gate watches (or holds); the handle stays open while it is in Young or GateHeld.</summary>
    private sealed class Tracked
    {
        public IntPtr Handle;
        public string Name;
        public DateTime Started;
        public DateTime HeldAt;
    }

    private sealed class Released
    {
        public int Pid;
        public string Name;
        public long HeldMs;
        public bool Forced;
    }

    // JOBOBJECT_CPU_RATE_CONTROL_INFORMATION (CpuRate in hundredths of a percent).
    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRateControl
    {
        public uint ControlFlags;
        public uint CpuRate;
    }

    // MEMORYSTATUSEX.
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
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
    }

    // PROCESS_MEMORY_COUNTERS_EX (PrivateUsage is the private memory Process.PrivateMemorySize64 reported).
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryCounters
    {
        public uint Size;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
        public UIntPtr PrivateUsage;
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref LimitViolation info, int length, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint ms);

        [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CompletionPortLink info, int length);

        [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref NotificationLimit info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetPriorityClass(IntPtr process, uint priorityClass);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetPriorityClass(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRateControl info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref uint info, int length);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr minimum, IntPtr maximum);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

        [DllImport("kernel32.dll", EntryPoint = "K32GetProcessMemoryInfo", SetLastError = true)]
        public static extern bool GetProcessMemoryInfo(IntPtr process, ref MemoryCounters counters, uint size);

        // NTSTATUS, not Win32: SetLastError does not apply, the status is the result (0 = success).
        [DllImport("ntdll.dll")]
        public static extern int NtSetInformationProcess(IntPtr process, int infoClass, ref int info, int length);

        [DllImport("ntdll.dll")]
        public static extern uint RtlNtStatusToDosError(int status);

        [DllImport("ntdll.dll")]
        public static extern int NtSuspendProcess(IntPtr process);

        [DllImport("ntdll.dll")]
        public static extern int NtResumeProcess(IntPtr process);
    }

    private static readonly object Gate = new object();
    private static readonly Dictionary<int, DateTime> Paused = new Dictionary<int, DateTime>();

    /// <summary>The paused process ids on disk, so a memgov that is killed mid-pause is undone by the next one.</summary>
    private static readonly string HeldFile = Path.Combine(Path.GetTempPath(), "agent-sandbox-memgov-held.txt");
    private static IntPtr job = IntPtr.Zero;
    private static IntPtr throttleJob = IntPtr.Zero;
    private static volatile bool stop;

    // The memory gate (null gate = off). Young, GateHeld and the ledger Paused are guarded by Gate; the rest belongs to GateLoop.
    private static readonly object OutLock = new object();
    private static GateSettings gate = null;
    private static readonly Dictionary<int, Tracked> Young = new Dictionary<int, Tracked>();
    private static readonly Dictionary<int, Tracked> GateHeld = new Dictionary<int, Tracked>();
    private static List<KeyValuePair<DateTime, long>> window = new List<KeyValuePair<DateTime, long>>();
    private static DateTime lastTrip = DateTime.MinValue;
    private static DateTime lastRelease = DateTime.MinValue;
    private static long armedMb = -1;
    private static HashSet<int> seenPids = new HashSet<int>();

    static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] != "serve")
        {
            Console.Error.WriteLine("usage: memgov serve [--interval seconds] [--gate growthMb:windowMs:releaseMs:maxHoldMs --gate-names a,b,c]");
            return 2;
        }
        int interval = 2;
        string gateSpec = null;
        string gateNames = null;
        for (int i = 1; i + 1 < args.Length; i++)
        {
            if (args[i] == "--interval")
            {
                int.TryParse(args[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out interval);
            }
            else if (args[i] == "--gate")
            {
                gateSpec = args[i + 1];
            }
            else if (args[i] == "--gate-names")
            {
                gateNames = args[i + 1];
            }
        }
        if (interval < 1)
        {
            interval = 2;
        }
        // A memgov that ended without resuming (killed, crashed) left its pauses in the file: undo them first.
        RecoverHeld();
        Thread gateThread = null;
        if (gateSpec != null)
        {
            gate = ParseGate(gateSpec, gateNames);
            if (gate == null)
            {
                EmitOff("bad --gate");
            }
            else
            {
                gateThread = new Thread(GateLoop);
                gateThread.IsBackground = true;
                gateThread.Start();
            }
        }
        // A memgov that ended while compilers were capped left the cap: lift it before anything else.
        SetCpuRate(100);
        Thread commands = new Thread(ReadCommands);
        commands.IsBackground = true;
        commands.Start();
        Thread resumer = new Thread(ResumeWhenDue);
        resumer.IsBackground = true;
        resumer.Start();
        while (!stop)
        {
            try
            {
                Emit(Sample());
            }
            catch (Exception)
            {
                // A sample that fails (a process ended while it was read) is skipped; the next one tries again.
            }
            for (int waited = 0; waited < interval * 10 && !stop; waited++)
            {
                Thread.Sleep(100);
            }
        }
        if (gateThread != null)
        {
            // The gate lifts its limit and closes its port when it sees stop; give it a moment.
            gateThread.Join(3000);
        }
        ResumeAll();
        SetCpuRate(100);
        return 0;
    }

    /// <summary>One line on stdout; the sample loop and the gate both write, so one at a time.</summary>
    private static void Emit(string json)
    {
        lock (OutLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    /// <summary>The self-test's own job (MEMGOV_JOB_NAME, a name in the agents' job family), or null.</summary>
    private static string TestJobName()
    {
        string name = Environment.GetEnvironmentVariable("MEMGOV_JOB_NAME");
        return !string.IsNullOrEmpty(name) && name.StartsWith(AgentJobName + "Test", StringComparison.Ordinal) ? name : null;
    }

    private static string JobName()
    {
        return TestJobName() ?? AgentJobName;
    }

    /// <summary>The job, opened once it exists (ptyhost makes it when the first agent starts).</summary>
    private static IntPtr Job()
    {
        if (job == IntPtr.Zero)
        {
            job = NativeMethods.OpenJobObjectW(JobObjectQuery, false, JobName());
        }
        return job;
    }

    private static string Sample()
    {
        MemoryStatus status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
        if (!NativeMethods.GlobalMemoryStatusEx(ref status))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ramTotalMb\":").Append(Mb(status.TotalPhys));
        sb.Append(",\"ramAvailMb\":").Append(Mb(status.AvailPhys));
        sb.Append(",\"commitLimitMb\":").Append(Mb(status.TotalPageFile));
        sb.Append(",\"commitAvailMb\":").Append(Mb(status.AvailPageFile));
        sb.Append(",\"procs\":[");
        bool first = true;
        int self = SelfId;
        foreach (int pid in JobProcessIds())
        {
            if (pid == self)
            {
                continue;
            }
            // Read everything first: a process that ends half way must not leave half an entry behind.
            string entry = Entry(pid);
            if (entry == null)
            {
                continue;
            }
            if (!first)
            {
                sb.Append(',');
            }
            first = false;
            sb.Append(entry);
        }
        int heldNow;
        lock (Gate)
        {
            heldNow = GateHeld.Count;
        }
        return sb.Append("],\"gateHeld\":").Append(heldNow.ToString(CultureInfo.InvariantCulture)).Append('}').ToString();
    }

    private static readonly int SelfId = Process.GetCurrentProcess().Id;

    /// <summary>
    /// One process's line, read through one handle: its name, private memory and priority (null when it ended). Not
    /// System.Diagnostics.Process, which reads the whole system's process list for every process it opens: with a
    /// build's dozens of processes every two seconds that alone kept a CPU busy.
    /// </summary>
    private static string Entry(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited, false, pid);
        if (process == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            StringBuilder path = new StringBuilder(1024);
            uint size = (uint)path.Capacity;
            if (!NativeMethods.QueryFullProcessImageNameW(process, 0, path, ref size))
            {
                return null;
            }
            MemoryCounters counters = new MemoryCounters();
            counters.Size = (uint)Marshal.SizeOf(typeof(MemoryCounters));
            if (!NativeMethods.GetProcessMemoryInfo(process, ref counters, counters.Size))
            {
                return null;
            }
            uint c = NativeMethods.GetPriorityClass(process);
            string priority = c == IdleClass ? "idle" : c == BelowNormalClass ? "below" : "normal";
            return "{\"pid\":" + pid.ToString(CultureInfo.InvariantCulture)
                + ",\"name\":" + Json(Path.GetFileNameWithoutExtension(path.ToString(0, (int)size)))
                + ",\"mb\":" + Mb(counters.PrivateUsage.ToUInt64())
                + ",\"prio\":\"" + priority + "\"}";
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    private static List<int> JobProcessIds()
    {
        List<int> ids = new List<int>();
        IntPtr handle = Job();
        if (handle == IntPtr.Zero)
        {
            return ids;
        }
        // JOBOBJECT_BASIC_PROCESS_ID_LIST: two counts, then the ids (pointer-sized).
        int length = 8 + IntPtr.Size * MaxProcesses;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!NativeMethods.QueryInformationJobObject(handle, JobObjectBasicProcessIdList, buffer, length, IntPtr.Zero))
            {
                return ids;
            }
            int count = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < count && i < MaxProcesses; i++)
            {
                ids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return ids;
    }

    /// <summary>Whether pid is a process of the agents' job and not this one: the only ones this program touches.</summary>
    private static bool Allowed(int pid)
    {
        return pid != SelfId && JobProcessIds().Contains(pid);
    }

    private static void ReadCommands()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try
            {
                Run(line.Trim().Split(' '));
            }
            catch (Exception)
            {
                // A bad command is ignored.
            }
            if (stop)
            {
                return;
            }
        }
        // The daemon is gone: put everything back and end.
        stop = true;
    }

    private static void Run(string[] parts)
    {
        if (parts.Length == 1 && parts[0] == "exit")
        {
            stop = true;
            return;
        }
        if (parts.Length == 2 && parts[0] == "cpurate")
        {
            int percent;
            if (int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out percent))
            {
                SetCpuRate(percent);
            }
            return;
        }
        int pid;
        if (parts.Length < 2 || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) || !Allowed(pid))
        {
            return;
        }
        if (parts[0] == "throttle")
        {
            Throttle(pid);
            return;
        }
        if (parts[0] == "trim")
        {
            Trim(pid);
            return;
        }
        if (parts.Length < 3)
        {
            return;
        }
        if (parts[0] == "memprio")
        {
            SetMemoryPriority(pid, parts[2] == "low" ? MemoryPriorityLow : MemoryPriorityNormal);
        }
        else if (parts[0] == "iopriority")
        {
            int level = ParseIoPriority(parts[2]);
            if (level >= 0)
            {
                SetIoPriority(pid, level);
            }
        }
        else if (parts[0] == "priority")
        {
            uint cls = parts[2] == "idle" ? IdleClass : parts[2] == "below" ? BelowNormalClass : NormalClass;
            IntPtr process = NativeMethods.OpenProcess(ProcessSetInformation, false, pid);
            if (process != IntPtr.Zero)
            {
                NativeMethods.SetPriorityClass(process, cls);
                NativeMethods.CloseHandle(process);
            }
        }
        else if (parts[0] == "suspend")
        {
            int ms;
            if (!int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out ms) || ms < 1)
            {
                return;
            }
            Suspend(pid, Math.Min(ms, MaxSuspendMs));
        }
    }

    /// <summary>The throttle job, made once. A process already in the agents' job is nested in it (Windows 8+).</summary>
    private static IntPtr ThrottleJob()
    {
        if (throttleJob == IntPtr.Zero)
        {
            string test = TestJobName();
            throttleJob = NativeMethods.CreateJobObjectW(IntPtr.Zero, test != null ? test + "Throttle" : ThrottleJobName);
        }
        return throttleJob;
    }

    /// <summary>The CPU cap of the compilers in the throttle job, percent of the sandbox; 100 or more lifts it.</summary>
    private static void SetCpuRate(int percent)
    {
        IntPtr throttle = ThrottleJob();
        if (throttle == IntPtr.Zero)
        {
            return;
        }
        CpuRateControl info = new CpuRateControl();
        if (percent < 100)
        {
            info.ControlFlags = CpuRateEnable | CpuRateHardCap;
            info.CpuRate = (uint)(Math.Max(1, percent) * 100);
        }
        NativeMethods.SetInformationJobObject(throttle, JobObjectCpuRateControlInformation, ref info, Marshal.SizeOf(typeof(CpuRateControl)));
    }

    private static void Throttle(int pid)
    {
        IntPtr throttle = ThrottleJob();
        if (throttle == IntPtr.Zero)
        {
            return;
        }
        IntPtr process = NativeMethods.OpenProcess(ProcessSetQuota | ProcessTerminate, false, pid);
        if (process == IntPtr.Zero)
        {
            return;
        }
        try
        {
            NativeMethods.AssignProcessToJobObject(throttle, process);
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>Low memory priority: Windows trims this process's pages before others' (the agents keep theirs).</summary>
    private static void SetMemoryPriority(int pid, uint priority)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessSetInformation, false, pid);
        if (process == IntPtr.Zero)
        {
            return;
        }
        try
        {
            uint value = priority;
            NativeMethods.SetProcessInformation(process, ProcessMemoryPriorityClass, ref value, sizeof(uint));
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>verylow, low or normal to the IO priority value; -1 when it is none of them.</summary>
    private static int ParseIoPriority(string word)
    {
        if (word == "verylow")
        {
            return IoPriorityVeryLow;
        }
        if (word == "low")
        {
            return IoPriorityLow;
        }
        return word == "normal" ? IoPriorityNormal : -1;
    }

    /// <summary>The process's disk requests queue behind the others' (needs no privilege for very low and low).</summary>
    private static void SetIoPriority(int pid, int level)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessSetInformation, false, pid);
        if (process == IntPtr.Zero)
        {
            return;
        }
        try
        {
            int value = level;
            int status = NativeMethods.NtSetInformationProcess(process, ProcessIoPriority, ref value, sizeof(int));
            if (status != 0)
            {
                throw new Win32Exception((int)NativeMethods.RtlNtStatusToDosError(status));
            }
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>A waiting compiler's pages go to the paging file now, so the ones that run have the RAM.</summary>
    private static void Trim(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessSetQuota, false, pid);
        if (process == IntPtr.Zero)
        {
            return;
        }
        try
        {
            NativeMethods.SetProcessWorkingSetSize(process, new IntPtr(-1), new IntPtr(-1));
        }
        finally
        {
            NativeMethods.CloseHandle(process);
        }
    }

    private static void Suspend(int pid, int ms)
    {
        lock (Gate)
        {
            if (Paused.ContainsKey(pid) || GateHeld.ContainsKey(pid))
            {
                return;
            }
            IntPtr process = NativeMethods.OpenProcess(ProcessSuspendResume, false, pid);
            if (process == IntPtr.Zero)
            {
                return;
            }
            try
            {
                // Recorded before the pause, so a memgov that dies right after still lets the next one resume it.
                Paused[pid] = DateTime.UtcNow.AddMilliseconds(ms);
                SaveHeld();
                NativeMethods.NtSuspendProcess(process);
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }
    }

    private static void Resume(int pid)
    {
        IntPtr process = NativeMethods.OpenProcess(ProcessSuspendResume, false, pid);
        if (process != IntPtr.Zero)
        {
            NativeMethods.NtResumeProcess(process);
            NativeMethods.CloseHandle(process);
        }
    }

    /// <summary>A paused process always comes back: when its time is up (checked every 100 ms).</summary>
    private static void ResumeWhenDue()
    {
        while (true)
        {
            Thread.Sleep(100);
            lock (Gate)
            {
                List<int> due = new List<int>();
                foreach (KeyValuePair<int, DateTime> p in Paused)
                {
                    if (p.Value <= DateTime.UtcNow)
                    {
                        due.Add(p.Key);
                    }
                }
                foreach (int pid in due)
                {
                    Resume(pid);
                    Paused.Remove(pid);
                }
                if (due.Count > 0)
                {
                    SaveHeld();
                }
            }
        }
    }

    private static void ResumeAll()
    {
        lock (Gate)
        {
            foreach (int pid in new List<int>(Paused.Keys))
            {
                Resume(pid);
            }
            Paused.Clear();
            foreach (Tracked t in GateHeld.Values)
            {
                NativeMethods.NtResumeProcess(t.Handle);
                NativeMethods.CloseHandle(t.Handle);
            }
            GateHeld.Clear();
            foreach (Tracked t in Young.Values)
            {
                NativeMethods.CloseHandle(t.Handle);
            }
            Young.Clear();
            SaveHeld();
        }
    }

    /// <summary>The processes paused or held by the gate right now, one id per line (empty: the file goes). Called with Gate held.</summary>
    private static void SaveHeld()
    {
        try
        {
            if (Paused.Count == 0 && GateHeld.Count == 0)
            {
                File.Delete(HeldFile);
                return;
            }
            List<string> lines = new List<string>();
            foreach (int pid in Paused.Keys)
            {
                lines.Add(pid.ToString(CultureInfo.InvariantCulture));
            }
            foreach (int pid in GateHeld.Keys)
            {
                if (!Paused.ContainsKey(pid))
                {
                    lines.Add(pid.ToString(CultureInfo.InvariantCulture));
                }
            }
            File.WriteAllLines(HeldFile, lines.ToArray());
        }
        catch (IOException)
        {
            // Best effort: the in-memory list still resumes every pause while this memgov runs.
        }
        catch (UnauthorizedAccessException)
        {
            // Same as above.
        }
    }

    /// <summary>Resumes what an earlier memgov paused and never resumed. Resuming a running process changes nothing.</summary>
    private static void RecoverHeld()
    {
        try
        {
            if (!File.Exists(HeldFile))
            {
                return;
            }
            foreach (string line in File.ReadAllLines(HeldFile))
            {
                int pid;
                if (int.TryParse(line.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out pid) && pid > 0)
                {
                    Resume(pid);
                }
            }
            File.Delete(HeldFile);
        }
        catch (IOException)
        {
            // Nothing more to do: the file stays and the next start tries again.
        }
        catch (UnauthorizedAccessException)
        {
            // Same as above.
        }
    }

    // ---- The memory gate -------------------------------------------------------------------------------------------
    // When the agents' programs gain committed memory faster than GrowthMb per WindowMs, build programs that start
    // (or just started) are frozen and let go one at a time, oldest first, never longer than MaxHoldMs. Windows tells
    // us through a notification limit on the job (a completion port); nothing is ever killed.

    /// <summary>growthMb:windowMs:releaseMs:maxHoldMs and the names the gate may freeze; null when either is invalid.</summary>
    private static GateSettings ParseGate(string spec, string names)
    {
        string[] parts = spec.Split(':');
        if (parts.Length != 4 || names == null)
        {
            return null;
        }
        int[] v = new int[4];
        for (int i = 0; i < 4; i++)
        {
            if (!int.TryParse(parts[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out v[i]))
            {
                return null;
            }
        }
        if (v[0] < 64 || v[1] < 500 || v[1] > 60000 || v[2] < 100 || v[2] > 60000 || v[3] < 1000 || v[3] > MaxSuspendMs)
        {
            return null;
        }
        HashSet<string> set = new HashSet<string>();
        foreach (string raw in names.Split(','))
        {
            string name = raw.Trim().ToLowerInvariant();
            if (name.Length > 0)
            {
                set.Add(name);
            }
        }
        if (set.Count == 0 || set.Count > MaxGateNames)
        {
            return null;
        }
        GateSettings g = new GateSettings();
        g.GrowthMb = v[0];
        g.WindowMs = v[1];
        g.ReleaseMs = v[2];
        g.MaxHoldMs = v[3];
        g.Names = set;
        return g;
    }

    private static string EventStart(string kind)
    {
        long at = (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
        return "{\"event\":\"gate\",\"kind\":\"" + kind + "\",\"at\":" + Num(at);
    }

    private static string Num(long value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    private static void EmitOff(string reason)
    {
        if (reason.Length > 150)
        {
            reason = reason.Substring(0, 150);
        }
        Emit(EventStart("off") + ",\"reason\":" + Json(reason) + "}");
    }

    /// <summary>Opens the job, joins its completion port, then reacts to births, exits and notifications until stop.</summary>
    private static void GateLoop()
    {
        IntPtr h = IntPtr.Zero;
        IntPtr port = IntPtr.Zero;
        try
        {
            // The job does not exist until the first ptyhost makes it.
            while (!stop)
            {
                h = NativeMethods.OpenJobObjectW(JobObjectQuery | JobObjectSetAttributes, false, JobName());
                if (h != IntPtr.Zero)
                {
                    break;
                }
                if (Marshal.GetLastWin32Error() == ErrorAccessDenied)
                {
                    EmitOff("cannot open the agents' job (access denied)");
                    return;
                }
                Thread.Sleep(500);
            }
            if (h == IntPtr.Zero)
            {
                return;
            }
            bool notify = true;
            port = NativeMethods.CreateIoCompletionPort(InvalidHandleValue, IntPtr.Zero, UIntPtr.Zero, 1);
            if (port == IntPtr.Zero)
            {
                notify = false;
            }
            else
            {
                // First drop a dead memgov's port (one port per job), then take the job over.
                SetPortLink(h, IntPtr.Zero, IntPtr.Zero);
                if (!SetPortLink(h, new IntPtr(1), port))
                {
                    NativeMethods.CloseHandle(port);
                    port = IntPtr.Zero;
                    notify = false;
                }
            }
            DateTime now = DateTime.UtcNow;
            long jobMb = JobCommitMb();
            window = new List<KeyValuePair<DateTime, long>>();
            window.Add(new KeyValuePair<DateTime, long>(now, jobMb));
            if (notify && !SetLimit(h, jobMb + gate.GrowthMb))
            {
                notify = false;
            }
            if (!notify)
            {
                seenPids = new HashSet<int>(JobProcessIds());
            }
            Emit(EventStart("ready") + ",\"mode\":\"" + (notify ? "notify" : "poll") + "\",\"growthMb\":" + Num(gate.GrowthMb)
                + ",\"windowMs\":" + Num(gate.WindowMs) + "}");
            DateTime lastTick = DateTime.UtcNow;
            while (!stop)
            {
                if (notify)
                {
                    uint msg;
                    UIntPtr key;
                    IntPtr overlapped;
                    if (NativeMethods.GetQueuedCompletionStatus(port, out msg, out key, out overlapped, GatePollMs))
                    {
                        int pid = (int)overlapped.ToInt64();
                        if (msg == JobMsgNewProcess)
                        {
                            OnBirth(pid);
                        }
                        else if (msg == JobMsgExitProcess || msg == JobMsgAbnormalExitProcess)
                        {
                            OnExit(pid);
                        }
                        else if (msg == JobMsgNotificationLimit)
                        {
                            OnNotified(h, pid);
                        }
                    }
                }
                else
                {
                    Thread.Sleep((int)GatePollMs);
                }
                if ((DateTime.UtcNow - lastTick).TotalMilliseconds >= GateTickMs)
                {
                    lastTick = DateTime.UtcNow;
                    Tick(h, notify);
                }
                ReleaseDue();
            }
        }
        catch (Exception e)
        {
            EmitOff(e.Message);
        }
        finally
        {
            if (h != IntPtr.Zero)
            {
                SetLimit(h, 0);
                SetPortLink(h, IntPtr.Zero, IntPtr.Zero);
                NativeMethods.CloseHandle(h);
            }
            if (port != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(port);
            }
        }
    }

    private static bool SetPortLink(IntPtr h, IntPtr completionKey, IntPtr completionPort)
    {
        CompletionPortLink link = new CompletionPortLink();
        link.CompletionKey = completionKey;
        link.CompletionPort = completionPort;
        return NativeMethods.SetInformationJobObject(h, JobObjectAssociateCompletionPortInformation, ref link, Marshal.SizeOf(typeof(CompletionPortLink)));
    }

    /// <summary>The notification mark in MB of job commit (0 removes it).</summary>
    private static bool SetLimit(IntPtr h, long mb)
    {
        NotificationLimit limit = new NotificationLimit();
        limit.LimitFlags = mb > 0 ? JobObjectLimitJobMemory : 0;
        limit.JobMemoryLimit = mb > 0 ? (ulong)(mb * BytesPerMb) : 0;
        bool ok = NativeMethods.SetInformationJobObject(h, JobObjectNotificationLimitInformation, ref limit, Marshal.SizeOf(typeof(NotificationLimit)));
        if (ok)
        {
            armedMb = mb;
        }
        return ok;
    }

    /// <summary>What the job's processes (not this one) hold in private memory, in MB.</summary>
    private static long JobCommitMb()
    {
        ulong total = 0;
        int self = SelfId;
        foreach (int pid in JobProcessIds())
        {
            if (pid == self)
            {
                continue;
            }
            IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited, false, pid);
            if (process == IntPtr.Zero)
            {
                continue;
            }
            try
            {
                MemoryCounters counters = new MemoryCounters();
                counters.Size = (uint)Marshal.SizeOf(typeof(MemoryCounters));
                if (NativeMethods.GetProcessMemoryInfo(process, ref counters, counters.Size))
                {
                    total += counters.PrivateUsage.ToUInt64();
                }
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }
        return (long)(total / (ulong)BytesPerMb);
    }

    /// <summary>The lower-case program name (no folder, no .exe) of an open process, or null.</summary>
    private static string ImageName(IntPtr process)
    {
        StringBuilder path = new StringBuilder(1024);
        uint size = (uint)path.Capacity;
        if (!NativeMethods.QueryFullProcessImageNameW(process, 0, path, ref size))
        {
            return null;
        }
        return Path.GetFileNameWithoutExtension(path.ToString(0, (int)size)).ToLowerInvariant();
    }

    /// <summary>
    /// Starts watching a process if the gate may freeze it by name; returns its name, or null when it is not one of
    /// those (or is already watched or held).
    /// </summary>
    private static string Track(int pid)
    {
        if (pid <= 0 || pid == SelfId)
        {
            return null;
        }
        IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited | ProcessSuspendResume, false, pid);
        if (process == IntPtr.Zero)
        {
            return null;
        }
        bool kept = false;
        try
        {
            string name = ImageName(process);
            if (name == null || !gate.Names.Contains(name))
            {
                return null;
            }
            lock (Gate)
            {
                if (Young.ContainsKey(pid) || GateHeld.ContainsKey(pid))
                {
                    return null;
                }
                Tracked t = new Tracked();
                t.Handle = process;
                t.Name = name;
                t.Started = DateTime.UtcNow;
                Young[pid] = t;
            }
            kept = true;
            return name;
        }
        finally
        {
            if (!kept)
            {
                NativeMethods.CloseHandle(process);
            }
        }
    }

    private static void OnBirth(int pid)
    {
        string name = Track(pid);
        if (name != null && BurstActive(DateTime.UtcNow) && Hold(pid))
        {
            Emit(EventStart("hold") + ",\"pid\":" + Num(pid) + ",\"name\":" + Json(name) + "}");
        }
    }

    private static void OnExit(int pid)
    {
        lock (Gate)
        {
            Tracked t;
            if (Young.TryGetValue(pid, out t))
            {
                NativeMethods.CloseHandle(t.Handle);
                Young.Remove(pid);
            }
            if (GateHeld.TryGetValue(pid, out t))
            {
                NativeMethods.CloseHandle(t.Handle);
                GateHeld.Remove(pid);
                SaveHeld();
            }
        }
    }

    /// <summary>The job crossed its mark. The query re-arms the notification, so it comes first and always.</summary>
    private static void OnNotified(IntPtr h, int pid)
    {
        LimitViolation v = new LimitViolation();
        bool queried = NativeMethods.QueryInformationJobObject(h, JobObjectLimitViolationInformation, ref v, Marshal.SizeOf(typeof(LimitViolation)), IntPtr.Zero);
        long jobMb;
        if (queried && (v.ViolationLimitFlags & JobObjectLimitJobMemory) != 0)
        {
            jobMb = (long)(v.JobMemory / (ulong)BytesPerMb);
        }
        else
        {
            jobMb = JobCommitMb();
        }
        Trip(h, true, pid, jobMb);
    }

    /// <summary>The lowest job commit in the window and when it was.</summary>
    private static long WindowMin(out DateTime at)
    {
        long min = long.MaxValue;
        at = DateTime.UtcNow;
        foreach (KeyValuePair<DateTime, long> entry in window)
        {
            if (entry.Value < min)
            {
                min = entry.Value;
                at = entry.Key;
            }
        }
        return min;
    }

    /// <summary>Every GateTickMs: the window, young entries, births in poll mode, the software trip and the moving mark.</summary>
    private static void Tick(IntPtr h, bool notify)
    {
        DateTime now = DateTime.UtcNow;
        long jobMb = JobCommitMb();
        window.Add(new KeyValuePair<DateTime, long>(now, jobMb));
        window.RemoveAll(delegate(KeyValuePair<DateTime, long> e) { return (now - e.Key).TotalMilliseconds > gate.WindowMs; });
        DateTime minAt;
        long min = WindowMin(out minAt);
        lock (Gate)
        {
            List<int> old = new List<int>();
            foreach (KeyValuePair<int, Tracked> p in Young)
            {
                if ((now - p.Value.Started).TotalMilliseconds > gate.WindowMs)
                {
                    old.Add(p.Key);
                }
            }
            foreach (int pid in old)
            {
                NativeMethods.CloseHandle(Young[pid].Handle);
                Young.Remove(pid);
            }
        }
        if (!notify)
        {
            List<int> current = JobProcessIds();
            foreach (int pid in current)
            {
                if (!seenPids.Contains(pid))
                {
                    OnBirth(pid);
                }
            }
            seenPids = new HashSet<int>(current);
        }
        if (jobMb - min >= gate.GrowthMb)
        {
            Trip(h, notify, 0, jobMb);
            return;
        }
        if (notify)
        {
            long target = min + gate.GrowthMb;
            if (Math.Abs(target - armedMb) >= GateRearmStepMb)
            {
                SetLimit(h, target);
            }
        }
    }

    /// <summary>A burst: freeze the young build programs (and the one that caused it), then move the mark up.</summary>
    private static void Trip(IntPtr h, bool notify, int causePid, long jobMb)
    {
        DateTime now = DateTime.UtcNow;
        long grew = 0;
        long ms = 0;
        if (window.Count > 0)
        {
            DateTime minAt;
            long min = WindowMin(out minAt);
            grew = Math.Max(0, jobMb - min);
            ms = Math.Max(0, (long)(now - minAt).TotalMilliseconds);
        }
        lastTrip = now;
        if (causePid > 0)
        {
            // The program that caused the notification, even if it is old (a no-op unless the gate may freeze its name).
            Track(causePid);
        }
        List<KeyValuePair<int, Tracked>> victims = new List<KeyValuePair<int, Tracked>>();
        lock (Gate)
        {
            foreach (KeyValuePair<int, Tracked> p in Young)
            {
                if (p.Key == causePid || (now - p.Value.Started).TotalMilliseconds < gate.WindowMs)
                {
                    victims.Add(p);
                }
            }
        }
        victims.Sort(delegate(KeyValuePair<int, Tracked> a, KeyValuePair<int, Tracked> b) { return a.Value.Started.CompareTo(b.Value.Started); });
        StringBuilder held = new StringBuilder();
        int count = 0;
        foreach (KeyValuePair<int, Tracked> victim in victims)
        {
            string name = victim.Value.Name;
            if (!Hold(victim.Key) || count >= MaxTripList)
            {
                continue;
            }
            if (count > 0)
            {
                held.Append(',');
            }
            held.Append("{\"pid\":").Append(Num(victim.Key)).Append(",\"name\":").Append(Json(name)).Append('}');
            count++;
        }
        Emit(EventStart("trip") + ",\"grewMb\":" + Num(grew) + ",\"ms\":" + Num(ms) + ",\"jobMb\":" + Num(jobMb)
            + ",\"held\":[" + held.ToString() + "]}");
        window = new List<KeyValuePair<DateTime, long>>();
        window.Add(new KeyValuePair<DateTime, long>(now, jobMb));
        if (notify)
        {
            SetLimit(h, jobMb + gate.GrowthMb);
        }
    }

    /// <summary>
    /// A burst went through less than WindowMs ago. Not "something is held": with fast compiles the queue would never
    /// empty, and every later program would start one per ReleaseMs while memory is calm.
    /// </summary>
    private static bool BurstActive(DateTime now)
    {
        lock (Gate)
        {
            return (now - lastTrip).TotalMilliseconds < gate.WindowMs;
        }
    }

    /// <summary>Freezes a watched process (unless the governor's timed pause has it); false when it was not frozen.</summary>
    private static bool Hold(int pid)
    {
        lock (Gate)
        {
            Tracked t;
            if (Paused.ContainsKey(pid) || GateHeld.ContainsKey(pid) || !Young.TryGetValue(pid, out t))
            {
                return false;
            }
            Young.Remove(pid);
            t.HeldAt = DateTime.UtcNow;
            GateHeld[pid] = t;
            // Recorded before the freeze, like the governor's pauses: a memgov that dies right after is undone by the next.
            SaveHeld();
            int status = NativeMethods.NtSuspendProcess(t.Handle);
            if (status != 0)
            {
                GateHeld.Remove(pid);
                NativeMethods.CloseHandle(t.Handle);
                SaveHeld();
                return false;
            }
            return true;
        }
    }

    /// <summary>Lets go what is due: anything held MaxHoldMs, and one process (the oldest) every ReleaseMs after a calm moment.</summary>
    private static void ReleaseDue()
    {
        List<Released> done = new List<Released>();
        lock (Gate)
        {
            if (GateHeld.Count == 0)
            {
                return;
            }
            DateTime now = DateTime.UtcNow;
            List<int> forced = new List<int>();
            foreach (KeyValuePair<int, Tracked> p in GateHeld)
            {
                if ((now - p.Value.HeldAt).TotalMilliseconds >= gate.MaxHoldMs)
                {
                    forced.Add(p.Key);
                }
            }
            foreach (int pid in forced)
            {
                done.Add(ReleaseOne(pid, now, true));
            }
            if (GateHeld.Count > 0 && (now - lastTrip).TotalMilliseconds >= gate.ReleaseMs
                && (now - lastRelease).TotalMilliseconds >= gate.ReleaseMs)
            {
                int oldest = 0;
                DateTime oldestAt = DateTime.MaxValue;
                foreach (KeyValuePair<int, Tracked> p in GateHeld)
                {
                    if (p.Value.HeldAt < oldestAt || (p.Value.HeldAt == oldestAt && p.Key < oldest))
                    {
                        oldest = p.Key;
                        oldestAt = p.Value.HeldAt;
                    }
                }
                done.Add(ReleaseOne(oldest, now, false));
                lastRelease = now;
            }
            if (done.Count > 0)
            {
                SaveHeld();
            }
        }
        foreach (Released r in done)
        {
            Emit(EventStart("release") + ",\"pid\":" + Num(r.Pid) + ",\"name\":" + Json(r.Name) + ",\"heldMs\":" + Num(r.HeldMs)
                + ",\"forced\":" + (r.Forced ? "true" : "false") + "}");
        }
    }

    /// <summary>Resumes and forgets one held process. Called with Gate held.</summary>
    private static Released ReleaseOne(int pid, DateTime now, bool forced)
    {
        Tracked t = GateHeld[pid];
        NativeMethods.NtResumeProcess(t.Handle);
        NativeMethods.CloseHandle(t.Handle);
        GateHeld.Remove(pid);
        Released r = new Released();
        r.Pid = pid;
        r.Name = t.Name;
        r.HeldMs = (long)(now - t.HeldAt).TotalMilliseconds;
        r.Forced = forced;
        return r;
    }

    private static string Mb(ulong bytes)
    {
        return Math.Floor(bytes / BytesPerMb).ToString("0", CultureInfo.InvariantCulture);
    }

    private static string Json(string value)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in value)
        {
            if (c == '"' || c == '\\')
            {
                sb.Append('\\').Append(c);
            }
            else if (c < 0x20)
            {
                sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.Append('"').ToString();
    }
}
