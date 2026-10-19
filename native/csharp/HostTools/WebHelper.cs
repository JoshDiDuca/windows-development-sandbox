// Windows sign-in for the web UI (docs/design/remote-access.md). C# 5.
//   web-helper --pipe NAME --server-pid N   long-running, for the owner's web server: serves the pipe NAME (one client
//       at a time) and asks Windows who connected (the client's token: user SID, integrity, AppContainer), writing
//       "door\t<n>\t<sid>\t<integrity>\t<appcontainer 0|1>\t<DOMAIN\user>" to stdout and writing the server's answer
//       ("answer\t<n>\t<text>" on stdin) back down the pipe. Requests on stdin, one per line, tab-separated:
//         peer <id> <local address> <local port> <remote address> <remote port>
//             the Windows user of the process at the other end of that loopback TCP connection (our server's end is
//             local): "peer\t<id>\tok\t<sid>\t<DOMAIN\user>" or "peer\t<id>\tnone\t<reason>"
//         lookup <id> <name>   "lookup\t<id>\tok\t<sid>\t<DOMAIN\user>" or "lookup\t<id>\tnone"
//       Ends when stdin closes.
//   door-client --owner USER   for another user's sandbox remote: USER (a name or a SID) is the owner; connects to
//       agent-sandbox-web-<their SID>, checks that the pipe's server runs in a session of that SID (so nobody else can
//       squat the name), sends "hello", prints the answer line. Exit 3: the pipe is not the owner's; 4: no such pipe;
//       5: no such user.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace AgentSandbox
{
    public static class WebHelper
    {
        private const int AfInet = 2;
        private const int TcpTableOwnerPidConnections = 4;
        private const int ErrorInsufficientBuffer = 122;
        private const int StateEstablished = 5;
        private const int WtsUserName = 5;
        private const int WtsDomainName = 7;
        private const int TokenIntegrityLevel = 25;
        private const int TokenIsAppContainer = 29;
        private const int AnswerTimeoutMs = 10000;
        private const int MaxLine = 512;
        public const int NotOwner = 3;
        public const int NoPipe = 4;
        public const int NoUser = 5;
        public const string PipePrefix = "agent-sandbox-web-";

        private static readonly object StdoutLock = new object();
        private static readonly object AnswerLock = new object();
        private static string pendingAnswer;
        private static int pendingNumber;

        private static class NativeMethods
        {
            [DllImport("iphlpapi.dll", SetLastError = true)]
            public static extern int GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, int reserved);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

            [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern bool WTSQuerySessionInformation(IntPtr server, uint sessionId, int infoClass, out IntPtr buffer, out int bytes);

            [DllImport("wtsapi32.dll")]
            public static extern void WTSFreeMemory(IntPtr memory);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

            [DllImport("advapi32.dll", SetLastError = true)]
            public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);
        }

        private static void Emit(string line)
        {
            lock (StdoutLock)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        private static string Clean(string text)
        {
            StringBuilder b = new StringBuilder();
            foreach (char c in text ?? "")
            {
                if (c >= ' ' && c != '\t' && c != '\u007f')
                {
                    b.Append(c);
                }
            }
            return b.ToString();
        }

        /// <summary>Serves the pipe and answers requests until stdin closes.</summary>
        public static int Serve(string pipeName, int serverPid)
        {
            // An empty name: no Windows sign-in, only the peer checks and lookups.
            if (pipeName.Length > 0)
            {
                Thread door = new Thread(delegate () { DoorLoop(pipeName); });
                door.IsBackground = true;
                door.Start();
            }
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Length > MaxLine)
                {
                    continue;
                }
                string[] f = line.Split('\t');
                try
                {
                    if (f[0] == "peer" && f.Length == 6)
                    {
                        Emit(Peer(f[1], f[2], f[3], f[4], f[5], serverPid));
                    }
                    else if (f[0] == "lookup" && f.Length == 3)
                    {
                        Emit(Lookup(f[1], f[2]));
                    }
                    else if (f[0] == "answer" && f.Length == 3)
                    {
                        int n;
                        if (int.TryParse(f[1], out n))
                        {
                            lock (AnswerLock)
                            {
                                if (n == pendingNumber)
                                {
                                    pendingAnswer = f[2];
                                    Monitor.PulseAll(AnswerLock);
                                }
                            }
                        }
                    }
                }
                catch (Exception e)
                {
                    Emit("error\t" + Clean(f.Length > 1 ? f[1] : "") + "\t" + Clean(e.Message));
                }
            }
            return 0;
        }

        private static PipeSecurity Security()
        {
            PipeSecurity security = new PipeSecurity();
            SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
            security.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            return security;
        }

        private static void DoorLoop(string pipeName)
        {
            int number = 0;
            while (true)
            {
                NamedPipeServerStream pipe;
                try
                {
                    // One instance: if someone else made this name first, this fails and sign-in stays off.
                    pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 1024, 1024, Security());
                }
                catch (Exception e)
                {
                    Emit("door-failed\t" + Clean(e.Message));
                    return;
                }
                try
                {
                    pipe.WaitForConnection();
                    number++;
                    string sid = "";
                    string user = "";
                    int integrity = 0;
                    bool container = true;
                    pipe.RunAsClient(delegate ()
                    {
                        using (WindowsIdentity client = WindowsIdentity.GetCurrent(TokenAccessLevels.Query))
                        {
                            sid = client.User == null ? "" : client.User.Value;
                            user = client.Name;
                            integrity = Integrity(client.Token);
                            container = IsAppContainer(client.Token);
                        }
                    });
                    StreamReader reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true);
                    string hello = ReadBounded(reader);
                    string answer = "refused\tNo answer.";
                    if (hello == "hello")
                    {
                        lock (AnswerLock)
                        {
                            pendingNumber = number;
                            pendingAnswer = null;
                            Emit("door\t" + number + "\t" + sid + "\t" + integrity + "\t" + (container ? "1" : "0") + "\t" + Clean(user));
                            Monitor.Wait(AnswerLock, AnswerTimeoutMs);
                            if (pendingAnswer != null)
                            {
                                answer = pendingAnswer;
                            }
                            pendingNumber = 0;
                        }
                    }
                    byte[] bytes = Encoding.UTF8.GetBytes(Clean(answer.Replace('\t', ' ')) + "\n");
                    pipe.Write(bytes, 0, bytes.Length);
                    pipe.Flush();
                    pipe.WaitForPipeDrain();
                }
                catch (Exception)
                {
                    // A client that went away or sent nonsense: next one.
                }
                finally
                {
                    pipe.Dispose();
                }
            }
        }

        private static string ReadBounded(StreamReader reader)
        {
            StringBuilder b = new StringBuilder();
            int c;
            while (b.Length < MaxLine && (c = reader.Read()) >= 0 && c != '\n')
            {
                if (c != '\r')
                {
                    b.Append((char)c);
                }
            }
            return b.ToString();
        }

        private static int Integrity(IntPtr token)
        {
            int size;
            NativeMethods.GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
            if (size <= 0)
            {
                return 0;
            }
            IntPtr info = Marshal.AllocHGlobal(size);
            try
            {
                if (!NativeMethods.GetTokenInformation(token, TokenIntegrityLevel, info, size, out size))
                {
                    return 0;
                }
                IntPtr sid = Marshal.ReadIntPtr(info);
                int count = Marshal.ReadByte(NativeMethods.GetSidSubAuthorityCount(sid));
                return count == 0 ? 0 : Marshal.ReadInt32(NativeMethods.GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally
            {
                Marshal.FreeHGlobal(info);
            }
        }

        private static bool IsAppContainer(IntPtr token)
        {
            IntPtr info = Marshal.AllocHGlobal(4);
            try
            {
                int returned;
                // A token that cannot be asked counts as an AppContainer: refused.
                return !NativeMethods.GetTokenInformation(token, TokenIsAppContainer, info, 4, out returned) || Marshal.ReadInt32(info) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(info);
            }
        }

        private struct Row
        {
            public int State;
            public uint LocalAddr;
            public int LocalPort;
            public uint RemoteAddr;
            public int RemotePort;
            public uint Pid;
        }

        private static Row[] TcpTable()
        {
            int size = 0;
            NativeMethods.GetExtendedTcpTable(IntPtr.Zero, ref size, false, AfInet, TcpTableOwnerPidConnections, 0);
            for (int attempt = 0; attempt < 5; attempt++)
            {
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    int result = NativeMethods.GetExtendedTcpTable(buffer, ref size, false, AfInet, TcpTableOwnerPidConnections, 0);
                    if (result == ErrorInsufficientBuffer)
                    {
                        continue;
                    }
                    if (result != 0)
                    {
                        throw new Win32Exception(result);
                    }
                    int count = Marshal.ReadInt32(buffer);
                    Row[] rows = new Row[count];
                    for (int i = 0; i < count; i++)
                    {
                        IntPtr at = buffer + 4 + i * 24;
                        rows[i].State = Marshal.ReadInt32(at);
                        rows[i].LocalAddr = (uint)Marshal.ReadInt32(at + 4);
                        rows[i].LocalPort = Port(Marshal.ReadInt32(at + 8));
                        rows[i].RemoteAddr = (uint)Marshal.ReadInt32(at + 12);
                        rows[i].RemotePort = Port(Marshal.ReadInt32(at + 16));
                        rows[i].Pid = (uint)Marshal.ReadInt32(at + 20);
                    }
                    return rows;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            throw new InvalidOperationException("The TCP table kept growing.");
        }

        private static int Port(int raw)
        {
            return ((raw & 0xff) << 8) | ((raw >> 8) & 0xff);
        }

        private static uint Address(string text)
        {
            IPAddress ip = IPAddress.Parse(text);
            byte[] b = ip.GetAddressBytes();
            if (b.Length != 4)
            {
                throw new ArgumentException("IPv4 only.");
            }
            return BitConverter.ToUInt32(b, 0);
        }

        /// <summary>The process at the client end, read twice around the session lookup (same pid, still established).</summary>
        private static string Peer(string id, string localAddr, string localPort, string remoteAddr, string remotePort, int serverPid)
        {
            uint la = Address(localAddr);
            uint ra = Address(remoteAddr);
            int lp = int.Parse(localPort);
            int rp = int.Parse(remotePort);
            uint pid;
            string why = ClientPid(la, lp, ra, rp, serverPid, out pid);
            if (why != null)
            {
                return "peer\t" + id + "\tnone\t" + why;
            }
            uint session;
            if (!NativeMethods.ProcessIdToSessionId(pid, out session))
            {
                return "peer\t" + id + "\tnone\tno session";
            }
            if (session == 0)
            {
                return "peer\t" + id + "\tnone\tservice session";
            }
            string account = SessionUser(session);
            uint again;
            if (account == null || ClientPid(la, lp, ra, rp, serverPid, out again) != null || again != pid)
            {
                return "peer\t" + id + "\tnone\tchanged while checking";
            }
            string sid = SidOf(account);
            return sid == null ? "peer\t" + id + "\tnone\tunknown user" : "peer\t" + id + "\tok\t" + sid + "\t" + Clean(account);
        }

        private static string ClientPid(uint la, int lp, uint ra, int rp, int serverPid, out uint pid)
        {
            pid = 0;
            bool ours = false;
            foreach (Row r in TcpTable())
            {
                if (r.LocalAddr == la && r.LocalPort == lp && r.RemoteAddr == ra && r.RemotePort == rp)
                {
                    ours = r.Pid == (uint)serverPid && r.State == StateEstablished;
                }
                if (r.LocalAddr == ra && r.LocalPort == rp && r.RemoteAddr == la && r.RemotePort == lp && r.State == StateEstablished)
                {
                    pid = r.Pid;
                }
            }
            if (!ours)
            {
                return "not our connection";
            }
            return pid == 0 ? "no such connection" : null;
        }

        private static string SessionUser(uint session)
        {
            string user = SessionText(session, WtsUserName);
            string domain = SessionText(session, WtsDomainName);
            if (string.IsNullOrEmpty(user))
            {
                return null;
            }
            return string.IsNullOrEmpty(domain) ? user : domain + "\\" + user;
        }

        private static string SessionText(uint session, int infoClass)
        {
            IntPtr buffer;
            int bytes;
            if (!NativeMethods.WTSQuerySessionInformation(IntPtr.Zero, session, infoClass, out buffer, out bytes))
            {
                return null;
            }
            try
            {
                return Marshal.PtrToStringUni(buffer);
            }
            finally
            {
                NativeMethods.WTSFreeMemory(buffer);
            }
        }

        private static string SidOf(string account)
        {
            try
            {
                return ((SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier))).Value;
            }
            catch (IdentityNotMappedException)
            {
                return null;
            }
        }

        private static string Lookup(string id, string name)
        {
            string sid = SidOf(name);
            if (sid == null)
            {
                return "lookup\t" + id + "\tnone";
            }
            string full = ((NTAccount)new SecurityIdentifier(sid).Translate(typeof(NTAccount))).Value;
            return "lookup\t" + id + "\tok\t" + sid + "\t" + Clean(full);
        }

        /// <summary>The other user's side: the pipe must be served from a session of the owner; prints the answer.</summary>
        public static int Client(string owner)
        {
            string ownerSid = owner.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase) ? owner : SidOf(owner);
            if (ownerSid == null)
            {
                return NoUser;
            }
            string pipeName = PipePrefix + ownerSid;
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Identification))
            {
                try
                {
                    pipe.Connect(3000);
                }
                catch (TimeoutException)
                {
                    return NoPipe;
                }
                catch (IOException)
                {
                    return NoPipe;
                }
                uint serverPid;
                uint session;
                if (!NativeMethods.GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out serverPid) || !NativeMethods.ProcessIdToSessionId(serverPid, out session))
                {
                    return NotOwner;
                }
                string account = SessionUser(session);
                if (account == null || !string.Equals(SidOf(account), ownerSid, StringComparison.OrdinalIgnoreCase))
                {
                    return NotOwner;
                }
                byte[] hello = Encoding.UTF8.GetBytes("hello\n");
                pipe.Write(hello, 0, hello.Length);
                pipe.Flush();
                StreamReader reader = new StreamReader(pipe, Encoding.UTF8);
                Console.Out.Write(Clean(ReadBounded(reader)));
                return 0;
            }
        }
    }
}
