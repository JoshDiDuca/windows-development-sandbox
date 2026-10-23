// The pipe \\.\pipe\AgentSandboxStorage. All four instances are created at start (the first one with
// FILE_FLAG_FIRST_PIPE_INSTANCE, so a pipe someone made first stops the service) and reused for good: the instance
// count never drops below the maximum, so nobody can add an instance of their own and catch other users' calls.
// Remote clients are refused (PIPE_REJECT_REMOTE_CLIENTS and a deny entry for NETWORK); only SYSTEM, Administrators and
// the "Agent Sandbox Users" group may open it. One request per connection: read one line (512 bytes, 5 seconds), find
// out who called, rate-limit, work out that user's storage from their settings, do the one operation (one at a time,
// under a lock that only administrators may hold), answer, log.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class ServerOptions
    {
        public string PipeName { get; set; }
        public string MutexName { get; set; }
        public SecurityIdentifier Group { get; set; }
        public Log Log { get; set; }
        public SettingsSources Sources { get; set; }
        public bool DryRun { get; set; }

        /// <summary>Where mounts are recorded (null in a dry run of the tests).</summary>
        public MountRecords Records { get; set; }
    }

    public sealed class Server : IDisposable
    {
        public const string DefaultPipe = "AgentSandboxStorage";
        public const string DefaultMutex = "Global\\AgentSandboxContainedStorage";
        private const int Instances = 4;
        private const int BufferBytes = 4096;
        private const uint PipeAccessDuplex = 0x3;
        private const uint FlagOverlapped = 0x40000000;
        private const uint FlagFirstPipeInstance = 0x00080000;
        private const uint PipeTypeByte = 0x0;
        private const uint PipeRejectRemoteClients = 0x8;
        private const int ErrorIoPending = 997;
        private const int ErrorPipeConnected = 535;
        private const int ErrorBrokenPipe = 109;
        private const int ErrorOperationAborted = 995;
        private const uint WaitObject0 = 0;
        private const int ReadTimeoutMs = 5000;
        private const int LockTimeoutMs = 120000;

        private readonly ServerOptions options;
        private readonly RateLimiter limiter = new RateLimiter(10, 60, TimeSpan.FromMinutes(1));
        private readonly object work = new object();
        private readonly ManualResetEvent stopping = new ManualResetEvent(false);
        private readonly SafePipe[] pipes = new SafePipe[Instances];
        private readonly Thread[] threads = new Thread[Instances];
        private Mutex machineLock;

        public Server(ServerOptions options)
        {
            this.options = options;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr Descriptor;
            public int Inherit;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Overlapped
        {
            public IntPtr Internal;
            public IntPtr InternalHigh;
            public uint Offset;
            public uint OffsetHigh;
            public IntPtr Event;
        }

        public sealed class SafePipe : SafeHandleZeroOrMinusOneIsInvalid
        {
            public SafePipe() : base(true)
            {
            }

            protected override bool ReleaseHandle()
            {
                return NativeMethods.CloseHandle(handle);
            }
        }

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern SafePipe CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes security);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool ConnectNamedPipe(SafePipe pipe, IntPtr overlapped);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool DisconnectNamedPipe(SafePipe pipe);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool ReadFile(SafePipe pipe, IntPtr buffer, int count, IntPtr read, IntPtr overlapped);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool WriteFile(SafePipe pipe, IntPtr buffer, int count, IntPtr written, IntPtr overlapped);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetOverlappedResult(SafePipe pipe, IntPtr overlapped, out int transferred, [MarshalAs(UnmanagedType.Bool)] bool wait);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CancelIoEx(SafePipe pipe, IntPtr overlapped);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, [MarshalAs(UnmanagedType.Bool)] bool waitAll, uint milliseconds);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        /// <summary>SYSTEM, Administrators, the group; nobody over the network (the deny entry comes first).</summary>
        public static string PipeSddl(SecurityIdentifier group)
        {
            return "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + group.Value + ")";
        }

        /// <summary>Creates the lock and every pipe instance; throws when the pipe exists already (someone made it first).</summary>
        public void Start()
        {
            machineLock = CreateMachineLock(options.MutexName, options.Log);
            RawSecurityDescriptor sd = new RawSecurityDescriptor(PipeSddl(options.Group));
            byte[] sdBytes = new byte[sd.BinaryLength];
            sd.GetBinaryForm(sdBytes, 0);
            GCHandle pinned = GCHandle.Alloc(sdBytes, GCHandleType.Pinned);
            try
            {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.Descriptor = pinned.AddrOfPinnedObject();
                for (int i = 0; i < Instances; i++)
                {
                    uint mode = PipeAccessDuplex | FlagOverlapped | (i == 0 ? FlagFirstPipeInstance : 0);
                    SafePipe pipe = NativeMethods.CreateNamedPipeW("\\\\.\\pipe\\" + options.PipeName, mode, PipeTypeByte | PipeRejectRemoteClients, Instances, BufferBytes, BufferBytes, 0, ref attributes);
                    if (pipe.IsInvalid)
                    {
                        Win32Exception e = Win32.LastError(i == 0 ? "The pipe " + options.PipeName + " exists already (another program made it); not starting" : "Could not create the pipe");
                        pipe.Dispose();
                        throw e;
                    }
                    pipes[i] = pipe;
                }
            }
            finally
            {
                pinned.Free();
            }
            for (int i = 0; i < Instances; i++)
            {
                int index = i;
                threads[i] = new Thread(delegate() { Serve(pipes[index]); });
                threads[i].IsBackground = true;
                threads[i].Start();
            }
            options.Log.Note("started: pipe " + options.PipeName + (options.DryRun ? " (dry run)" : ""));
            Tidy();
        }

        /// <summary>Mount points left by a restart (their disk is gone) are taken off; mounts that are still there stay.</summary>
        private void Tidy()
        {
            if (options.Records == null)
            {
                return;
            }
            foreach (MountRecord record in options.Records.Read())
            {
                Request request = RecordRequest(record);
                request.OnlyIfDetached = true;
                Outcome outcome = RunLocked(request);
                if (outcome.Ok && !outcome.AlreadyMounted)
                {
                    options.Records.Remove(record);
                }
                options.Log.Write(record.Sid, "", 0, "(service start)", "tidy", record.Set, (outcome.Ok ? "ok: " : "refused: ") + outcome.Message);
            }
        }

        /// <summary>A dismount of a recorded mount, with the usual checks (the image must still belong to that user).</summary>
        public static Request RecordRequest(MountRecord record)
        {
            Request request = new Request();
            request.Verb = "dismount";
            request.Set = record.Set;
            request.User = new SecurityIdentifier(record.Sid);
            request.Settings = new StorageSettings(record.StorageRoot, Rules.MaxGb);
            return request;
        }

        /// <summary>The lock shared with mount-contained.ps1, created with a DACL that lets only SYSTEM and Administrators open it.</summary>
        private static Mutex CreateMachineLock(string name, Log log)
        {
            MutexSecurity security = new MutexSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new MutexAccessRule(new SecurityIdentifier("S-1-5-18"), MutexRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new MutexAccessRule(new SecurityIdentifier("S-1-5-32-544"), MutexRights.FullControl, AccessControlType.Allow));
            bool createdNew;
            Mutex mutex = new Mutex(false, name, out createdNew, security);
            if (!createdNew)
            {
                log.Note("the lock " + name + " existed before the service started (another program may hold it)");
            }
            return mutex;
        }

        private void Serve(SafePipe pipe)
        {
            using (ManualResetEvent ready = new ManualResetEvent(false))
            {
                while (!stopping.WaitOne(0))
                {
                    try
                    {
                        if (!WaitForClient(pipe, ready))
                        {
                            return;
                        }
                        Handle(pipe, ready);
                    }
                    catch (Exception e)
                    {
                        options.Log.Note("pipe error: " + e.Message);
                        Thread.Sleep(100);
                    }
                    finally
                    {
                        NativeMethods.DisconnectNamedPipe(pipe);
                    }
                }
            }
        }

        private bool WaitForClient(SafePipe pipe, ManualResetEvent ready)
        {
            IntPtr overlapped = NewOverlapped(ready);
            try
            {
                if (NativeMethods.ConnectNamedPipe(pipe, overlapped))
                {
                    return true;
                }
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorPipeConnected)
                {
                    return true;
                }
                if (error != ErrorIoPending)
                {
                    throw new Win32Exception(error, "Waiting for a client failed");
                }
                uint which = NativeMethods.WaitForMultipleObjects(2, new IntPtr[] { ready.SafeWaitHandle.DangerousGetHandle(), stopping.SafeWaitHandle.DangerousGetHandle() }, false, 0xFFFFFFFF);
                if (which != WaitObject0)
                {
                    NativeMethods.CancelIoEx(pipe, overlapped);
                    int ignored;
                    NativeMethods.GetOverlappedResult(pipe, overlapped, out ignored, true);
                    return false;
                }
                int transferred;
                if (!NativeMethods.GetOverlappedResult(pipe, overlapped, out transferred, false))
                {
                    throw Win32.LastError("A client could not connect");
                }
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(overlapped);
            }
        }

        private void Handle(SafePipe pipe, ManualResetEvent ready)
        {
            string text = ReadLine(pipe, ready);
            if (text == null)
            {
                return;
            }
            Client client;
            try
            {
                client = Client.Of(pipe, options.Group);
            }
            catch (Exception e)
            {
                if (limiter.ShouldLogRefusal("unidentified", DateTime.UtcNow))
                {
                    options.Log.Write("", "", 0, "", "", "", "refused: " + e.Message);
                }
                Reply(pipe, ready, Refused(e is RefusedException ? e.Message : "The caller could not be identified."));
                return;
            }
            using (client)
            {
                string sid = client.Sid.Value;
                string verb = "";
                string set = "";
                Outcome outcome;
                if (!limiter.TryTake(sid, DateTime.UtcNow))
                {
                    if (limiter.ShouldLogRefusal(sid, DateTime.UtcNow))
                    {
                        options.Log.Write(sid, client.Account, client.Pid, client.Program, "", "", "refused: too many calls (further refusals this minute are not logged)");
                    }
                    Reply(pipe, ready, Refused("Too many calls; wait a minute and try again."));
                    return;
                }
                try
                {
                    Protocol.Parse(text, out verb, out set);
                    StorageSettings settings = UserSettings.For(client, options.Sources);
                    Request request = new Request();
                    request.Verb = verb;
                    request.Set = set;
                    request.User = client.Sid;
                    request.Token = client.Token;
                    request.Settings = settings;
                    request.DryRun = options.DryRun;
                    outcome = RunLocked(request);
                }
                catch (RefusedException e)
                {
                    outcome = Refused(e.Message);
                }
                catch (Win32Exception e)
                {
                    outcome = Refused(e.Message);
                }
                options.Log.Write(sid, client.Account, client.Pid, client.Program, verb, set, (outcome.Ok ? "ok: " : "refused: ") + outcome.Message);
                Reply(pipe, ready, outcome);
            }
        }

        private Outcome RunLocked(Request request)
        {
            if (!Monitor.TryEnter(work, LockTimeoutMs))
            {
                return Refused("Another mount or dismount is running. Try again in a minute.");
            }
            try
            {
                bool held = false;
                try
                {
                    try
                    {
                        held = machineLock.WaitOne(30000);
                    }
                    catch (AbandonedMutexException)
                    {
                        held = true;
                    }
                    if (!held)
                    {
                        return Refused("Another mount or dismount is running. Try again in a minute.");
                    }
                    Outcome outcome = Operations.Run(request);
                    Record(request, outcome);
                    return outcome;
                }
                finally
                {
                    if (held)
                    {
                        machineLock.ReleaseMutex();
                    }
                }
            }
            finally
            {
                Monitor.Exit(work);
            }
        }

        private void Record(Request request, Outcome outcome)
        {
            if (options.Records == null || request.DryRun || !outcome.Ok)
            {
                return;
            }
            try
            {
                MountRecord record = new MountRecord(request.User.Value, request.Settings.StorageRoot.TrimEnd('\\'), request.Set);
                if (request.Verb == "mount")
                {
                    options.Records.Add(record);
                }
                else if (!outcome.AlreadyMounted)
                {
                    options.Records.Remove(record);
                }
            }
            catch (Exception e)
            {
                options.Log.Note("could not update the mount record: " + e.Message);
            }
        }

        private static Outcome Refused(string message)
        {
            Outcome outcome = new Outcome();
            outcome.Ok = false;
            outcome.Message = message;
            return outcome;
        }

        /// <summary>One line (up to a newline, 512 bytes, 5 seconds); null when the client sent nothing usable.</summary>
        private string ReadLine(SafePipe pipe, ManualResetEvent ready)
        {
            byte[] collected = new byte[Protocol.MaxRequestBytes + 1];
            int count = 0;
            DateTime until = DateTime.UtcNow.AddMilliseconds(ReadTimeoutMs);
            while (count < collected.Length)
            {
                int left = (int)(until - DateTime.UtcNow).TotalMilliseconds;
                if (left <= 0)
                {
                    return null;
                }
                int n = Transfer(pipe, ready, false, collected, count, collected.Length - count, left);
                if (n <= 0)
                {
                    return null;
                }
                for (int i = count; i < count + n; i++)
                {
                    if (collected[i] == (byte)'\n')
                    {
                        return Encoding.UTF8.GetString(collected, 0, i).TrimEnd('\r');
                    }
                }
                count += n;
            }
            return null;
        }

        private void Reply(SafePipe pipe, ManualResetEvent ready, Outcome outcome)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(Protocol.Answer(outcome) + "\n");
            Transfer(pipe, ready, true, bytes, 0, bytes.Length, ReadTimeoutMs);
            // Wait (briefly) for the client to read and close, so disconnecting does not throw the answer away.
            byte[] rest = new byte[64];
            Transfer(pipe, ready, false, rest, 0, rest.Length, ReadTimeoutMs);
        }

        /// <summary>One overlapped read or write with a timeout; the bytes moved, 0 on end, timeout or error.</summary>
        private int Transfer(SafePipe pipe, ManualResetEvent ready, bool write, byte[] data, int offset, int count, int timeoutMs)
        {
            ready.Reset();
            IntPtr overlapped = NewOverlapped(ready);
            IntPtr buffer = Marshal.AllocHGlobal(count);
            try
            {
                if (write)
                {
                    Marshal.Copy(data, offset, buffer, count);
                }
                bool done = write ? NativeMethods.WriteFile(pipe, buffer, count, IntPtr.Zero, overlapped) : NativeMethods.ReadFile(pipe, buffer, count, IntPtr.Zero, overlapped);
                if (!done)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorIoPending)
                    {
                        return 0;
                    }
                    uint which = NativeMethods.WaitForMultipleObjects(2, new IntPtr[] { ready.SafeWaitHandle.DangerousGetHandle(), stopping.SafeWaitHandle.DangerousGetHandle() }, false, (uint)Math.Max(timeoutMs, 1));
                    if (which != WaitObject0)
                    {
                        NativeMethods.CancelIoEx(pipe, overlapped);
                    }
                }
                int transferred;
                if (!NativeMethods.GetOverlappedResult(pipe, overlapped, out transferred, true))
                {
                    return 0;
                }
                if (!write && transferred > 0)
                {
                    Marshal.Copy(buffer, data, offset, transferred);
                }
                return transferred;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
                Marshal.FreeHGlobal(overlapped);
            }
        }

        private static IntPtr NewOverlapped(ManualResetEvent ready)
        {
            ready.Reset();
            Overlapped o = new Overlapped();
            o.Event = ready.SafeWaitHandle.DangerousGetHandle();
            IntPtr p = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
            Marshal.StructureToPtr(o, p, false);
            return p;
        }

        public void Stop()
        {
            stopping.Set();
            foreach (Thread t in threads)
            {
                if (t != null)
                {
                    t.Join(10000);
                }
            }
        }

        public void Dispose()
        {
            Stop();
            foreach (SafePipe p in pipes)
            {
                if (p != null)
                {
                    p.Dispose();
                }
            }
            if (machineLock != null)
            {
                machineLock.Dispose();
            }
            stopping.Dispose();
        }
    }
}
