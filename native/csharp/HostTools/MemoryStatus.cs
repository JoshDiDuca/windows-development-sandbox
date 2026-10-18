// This PC's memory right now (HostTools memory-status): physical RAM and the commit limit (RAM plus paging files) with
// what is left of each. The commit limit is what a sandbox's memory is charged against, so it matters as much as RAM.
// C# 5.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace AgentSandbox
{
    public static class HostMemory
    {
        private const double BytesPerMb = 1024.0 * 1024.0;

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

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
        }

        /// <summary>{"totalMb":..,"availableMb":..,"commitLimitMb":..,"commitAvailableMb":..}; throws Win32Exception on failure.</summary>
        public static string Json()
        {
            MemoryStatus status = new MemoryStatus();
            status.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
            if (!NativeMethods.GlobalMemoryStatusEx(ref status))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return "{\"totalMb\":" + Mb(status.TotalPhys) +
                ",\"availableMb\":" + Mb(status.AvailPhys) +
                ",\"commitLimitMb\":" + Mb(status.TotalPageFile) +
                ",\"commitAvailableMb\":" + Mb(status.AvailPageFile) +
                "," + PageFileJson() + DiskQueueJson() + "}";
        }

        /// <summary>
        /// How this PC's paging file is set up, from the registry (read-only): "auto" (Windows manages it), "fixed"
        /// (with the total of the maximum sizes) or "none". An unreadable setting is reported as "auto".
        /// </summary>
        private static string PageFileJson()
        {
            string kind = "auto";
            long maxMb = 0;
            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management"))
                {
                    string[] files = key == null ? null : key.GetValue("PagingFiles") as string[];
                    if (files != null)
                    {
                        kind = "none";
                        foreach (string entry in files)
                        {
                            string[] parts = entry.Trim().Split(' ');
                            if (entry.Trim().Length == 0)
                            {
                                continue;
                            }
                            long initial = 0;
                            long max = 0;
                            if (parts.Length >= 3)
                            {
                                long.TryParse(parts[parts.Length - 2], NumberStyles.Integer, CultureInfo.InvariantCulture, out initial);
                                long.TryParse(parts[parts.Length - 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out max);
                            }
                            if (entry.StartsWith("?:") || (initial == 0 && max == 0))
                            {
                                kind = "auto";
                                maxMb = 0;
                                break;
                            }
                            kind = "fixed";
                            maxMb += max;
                        }
                    }
                }
            }
            catch (Exception)
            {
                // Not readable: the caller treats "auto" as "no warning".
            }
            return "\"pageFile\":\"" + kind + "\",\"pageFileMaxMb\":" + maxMb.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// The disks' queue length now (all disks together), as ,"diskQueue":n; empty when the counter is not available.
        /// Heavy builds through mapped folders show up here before anything else.
        /// </summary>
        private static string DiskQueueJson()
        {
            try
            {
                // Made once and kept: creating a performance counter costs far more than reading one.
                if (diskCounter == null && !noDiskCounter)
                {
                    diskCounter = new PerformanceCounter("PhysicalDisk", "Current Disk Queue Length", "_Total", true);
                }
                if (diskCounter == null)
                {
                    return "";
                }
                return ",\"diskQueue\":" + Math.Round(diskCounter.NextValue()).ToString("0", CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                // No performance counters on this PC: the watchdog then looks at memory and CPU only.
                noDiskCounter = true;
                diskCounter = null;
                return "";
            }
        }

        private static PerformanceCounter diskCounter;
        private static bool noDiskCounter;
        private static volatile bool inputClosed;

        /// <summary>
        /// memory-status --serve S: one JSON line every S seconds until stdin closes (the watcher keeps one of these
        /// instead of starting a program every few seconds). Returns the exit code.
        /// </summary>
        public static int Serve(int seconds)
        {
            Thread reader = new Thread(WaitForInputToClose);
            reader.IsBackground = true;
            reader.Start();
            while (!inputClosed)
            {
                try
                {
                    Console.Out.WriteLine(Json());
                    Console.Out.Flush();
                }
                catch (Exception)
                {
                    // One reading that fails is skipped; the next one tries again.
                }
                for (int waited = 0; waited < seconds * 10 && !inputClosed; waited++)
                {
                    Thread.Sleep(100);
                }
            }
            return 0;
        }

        private static void WaitForInputToClose()
        {
            try
            {
                while (Console.In.ReadLine() != null)
                {
                }
            }
            catch (Exception)
            {
                // A broken input counts as closed.
            }
            inputClosed = true;
        }

        private static string Mb(ulong bytes)
        {
            return Math.Floor(bytes / BytesPerMb).ToString("0", CultureInfo.InvariantCulture);
        }
    }
}
