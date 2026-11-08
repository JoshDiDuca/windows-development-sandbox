// MemoryBurst.exe <totalMb> <progressFile>: commits memory in 64 MB steps as fast as it can and appends
// "<epochMs> <mbSoFar>" to the progress file after each step, then "done". The self-test's stand-in for a compiler
// that commits gigabytes at once, so a frozen process shows as a gap in the progress file. C# 5.
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class MemoryBurst
{
    private const int StepMb = 64;
    private const long BytesPerMb = 1024L * 1024L;
    private const int PageBytes = 4096;
    private const uint MemCommitReserve = 0x3000;
    private const uint PageReadWrite = 0x04;
    private const int ExitMs = 300;

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint allocationType, uint protect);
    }

    static int Main(string[] args)
    {
        int totalMb;
        if (args.Length != 2 || !int.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out totalMb) || totalMb < 1)
        {
            Console.Error.WriteLine("usage: MemoryBurst <totalMb> <progressFile>");
            return 2;
        }
        string progress = args[1];
        int done = 0;
        while (done < totalMb)
        {
            IntPtr block = NativeMethods.VirtualAlloc(IntPtr.Zero, new UIntPtr((ulong)(StepMb * BytesPerMb)), MemCommitReserve, PageReadWrite);
            if (block == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            for (long offset = 0; offset < StepMb * BytesPerMb; offset += PageBytes)
            {
                Marshal.WriteByte(block, (int)offset, 1);
            }
            done += StepMb;
            long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            File.AppendAllText(progress, epochMs.ToString(CultureInfo.InvariantCulture) + " " + done.ToString(CultureInfo.InvariantCulture) + "\r\n");
        }
        File.AppendAllText(progress, "done\r\n");
        Thread.Sleep(ExitMs);
        return 0;
    }
}
