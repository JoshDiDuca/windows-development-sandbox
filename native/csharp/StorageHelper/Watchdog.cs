// A time limit for the steps that open the caller's own files (their settings, their folders, their image). The caller
// owns those files, so they could hold an opportunistic lock on one and make an open wait for as long as they like,
// stalling everyone else's calls. While a Watchdog is armed on a thread, a timer cancels whatever synchronous I/O is
// blocked on that thread (CancelSynchronousIo) once the limit is up; the open then fails and the call is refused. The
// long steps that touch only the service's own disk (partitioning and formatting a new image) run with it suspended.
using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace AgentSandbox.StorageHelper
{
    public sealed class Watchdog : IDisposable
    {
        private const uint ThreadTerminate = 0x0001;
        private const uint ThreadQueryInformation = 0x0040;

        [ThreadStatic]
        private static Watchdog current;

        private readonly object gate = new object();
        private readonly TimeSpan limit;
        private readonly IntPtr thread;
        private readonly Timer timer;
        private DateTime deadline;
        private bool finished;

        private static class NativeMethods
        {
            [DllImport("kernel32.dll")]
            public static extern uint GetCurrentThreadId();

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint threadId);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CancelSynchronousIo(IntPtr thread);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        /// <summary>Arms a limit for the calling thread; dispose it when the guarded steps are done.</summary>
        public Watchdog(TimeSpan limit)
        {
            this.limit = limit;
            deadline = DateTime.UtcNow + limit;
            thread = NativeMethods.OpenThread(ThreadTerminate | ThreadQueryInformation, false, NativeMethods.GetCurrentThreadId());
            timer = new Timer(Tick, null, TimeSpan.FromMilliseconds(500), TimeSpan.FromMilliseconds(500));
            current = this;
        }

        /// <summary>True once the limit was reached (something was cancelled, or is being).</summary>
        public bool Fired { get; private set; }

        /// <summary>The armed watchdog of this thread, if any.</summary>
        public static Watchdog Current
        {
            get { return current; }
        }

        private void Tick(object state)
        {
            lock (gate)
            {
                if (finished || thread == IntPtr.Zero || DateTime.UtcNow < deadline)
                {
                    return;
                }
                Fired = true;
                // Repeated on every tick: an open that starts after a cancel is cancelled too.
                NativeMethods.CancelSynchronousIo(thread);
            }
        }

        /// <summary>Runs a long step that touches no file of the caller with no limit; the limit starts again after it.</summary>
        public static void Suspended(Action step)
        {
            Watchdog dog = current;
            if (dog == null)
            {
                step();
                return;
            }
            lock (dog.gate)
            {
                dog.deadline = DateTime.MaxValue;
            }
            try
            {
                step();
            }
            finally
            {
                lock (dog.gate)
                {
                    dog.deadline = DateTime.UtcNow + dog.limit;
                }
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                finished = true;
            }
            timer.Dispose();
            if (current == this)
            {
                current = null;
            }
            if (thread != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(thread);
            }
        }
    }

    /// <summary>A step on the caller's own files took longer than the limit and was cancelled.</summary>
    public sealed class TimedOutException : Exception
    {
        public TimedOutException() : base("Your storage folder or image took too long to open (another program holds it); try again in a few minutes.")
        {
        }
    }
}
