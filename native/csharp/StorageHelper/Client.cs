// Who is on the other end of the pipe, from Windows and never from the message: the token of the connected client
// (ImpersonateNamedPipeClient, taken and reverted at once), checked to be a real interactive user (impersonation level,
// not anonymous or a service account, medium integrity or higher, not an app container or restricted token, a member
// of the "Agent Sandbox Users" group or Administrators), and the client process (GetNamedPipeClientProcessId), whose
// user must be the same. The token is kept only to read that user's settings file and environment.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class Client : IDisposable
    {
        private const uint TokenQuery = 0x0008;
        private const uint TokenDuplicate = 0x0002;
        private const uint TokenImpersonate = 0x0004;
        private const int TokenUserClass = 1;
        private const int TokenImpersonationLevelClass = 9;
        private const int TokenIntegrityLevelClass = 25;
        private const int TokenIsAppContainerClass = 29;
        private const int SecurityImpersonation = 2;
        private const int MediumIntegrity = 0x2000;
        private const uint ProcessQueryLimited = 0x1000;
        private static readonly string[] ServiceAccounts = { "S-1-5-7", "S-1-5-18", "S-1-5-19", "S-1-5-20" };
        private static readonly SecurityIdentifier Administrators = new SecurityIdentifier("S-1-5-32-544");

        private Client(SafeAccessTokenHandle token, SecurityIdentifier sid, int pid, string program)
        {
            Token = token;
            Sid = sid;
            Pid = pid;
            Program = program;
        }

        public SafeAccessTokenHandle Token { get; private set; }
        public SecurityIdentifier Sid { get; private set; }
        public int Pid { get; private set; }
        public string Program { get; private set; }

        public string Account
        {
            get
            {
                try
                {
                    return Sid.Translate(typeof(NTAccount)).Value;
                }
                catch (Exception)
                {
                    return "";
                }
            }
        }

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetNamedPipeClientProcessId(SafeHandle pipe, out uint processId);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool ImpersonateNamedPipeClient(SafeHandle pipe);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool RevertToSelf();

            [DllImport("kernel32.dll")]
            public static extern IntPtr GetCurrentThread();

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool OpenThreadToken(IntPtr thread, uint access, [MarshalAs(UnmanagedType.Bool)] bool openAsSelf, out SafeAccessTokenHandle token);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetTokenInformation(SafeAccessTokenHandle token, int infoClass, byte[] info, int length, out int returned);

            [DllImport("advapi32.dll", EntryPoint = "GetTokenInformation", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetTokenInformationPtr(SafeAccessTokenHandle token, int infoClass, IntPtr info, int length, out int returned);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool IsTokenRestricted(SafeAccessTokenHandle token);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CheckTokenMembership(SafeAccessTokenHandle token, byte[] sid, [MarshalAs(UnmanagedType.Bool)] out bool isMember);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

            [DllImport("advapi32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        /// <summary>The checked client of a pipe that has already received the request (impersonation needs that).</summary>
        public static Client Of(SafeHandle h, SecurityIdentifier group)
        {
            uint pid;
            if (!NativeMethods.GetNamedPipeClientProcessId(h, out pid))
            {
                throw Win32.LastError("Could not tell which program is calling");
            }
            SafeAccessTokenHandle token;
            if (!NativeMethods.ImpersonateNamedPipeClient(h))
            {
                throw Win32.LastError("Could not tell who is calling");
            }
            try
            {
                if (!NativeMethods.OpenThreadToken(NativeMethods.GetCurrentThread(), TokenQuery | TokenDuplicate | TokenImpersonate, true, out token))
                {
                    throw Win32.LastError("Could not tell who is calling");
                }
            }
            finally
            {
                if (!NativeMethods.RevertToSelf())
                {
                    // Running on as the caller would be worse than stopping: end the service.
                    Environment.FailFast("RevertToSelf failed");
                }
            }
            try
            {
                SecurityIdentifier sid = Check(token, group);
                string program;
                SecurityIdentifier processUser = ProcessUser(pid, out program);
                if (processUser == null || !processUser.Equals(sid))
                {
                    throw new RefusedException("The calling program does not run as the user who called.");
                }
                return new Client(token, sid, (int)pid, program);
            }
            catch
            {
                token.Dispose();
                throw;
            }
        }

        /// <summary>The user of a token that may use this service, or an exception that says why not.</summary>
        public static SecurityIdentifier Check(SafeAccessTokenHandle token, SecurityIdentifier group)
        {
            byte[] level = Info(token, TokenImpersonationLevelClass);
            if (BitConverter.ToInt32(level, 0) < SecurityImpersonation)
            {
                throw new RefusedException("The caller did not allow the service to act as them.");
            }
            SecurityIdentifier sid = SidIn(token, TokenUserClass);
            if (Array.IndexOf(ServiceAccounts, sid.Value) >= 0 || sid.IsWellKnown(WellKnownSidType.AnonymousSid))
            {
                throw new RefusedException("Service accounts cannot use contained storage.");
            }
            SecurityIdentifier label = SidIn(token, TokenIntegrityLevelClass);
            byte[] labelBytes = new byte[label.BinaryLength];
            label.GetBinaryForm(labelBytes, 0);
            int rid = BitConverter.ToInt32(labelBytes, labelBytes.Length - 4);
            if (rid < MediumIntegrity)
            {
                throw new RefusedException("A program at low integrity cannot use contained storage.");
            }
            if (BitConverter.ToInt32(Info(token, TokenIsAppContainerClass), 0) != 0)
            {
                throw new RefusedException("An app container cannot use contained storage.");
            }
            if (NativeMethods.IsTokenRestricted(token))
            {
                throw new RefusedException("A restricted program cannot use contained storage.");
            }
            if (!IsMember(token, group) && !IsMember(token, Administrators))
            {
                throw new RefusedException("Only members of the Agent Sandbox Users group may use this (sign out and in after being added).");
            }
            return sid;
        }

        private static bool IsMember(SafeAccessTokenHandle token, SecurityIdentifier sid)
        {
            if (sid == null)
            {
                return false;
            }
            byte[] bytes = new byte[sid.BinaryLength];
            sid.GetBinaryForm(bytes, 0);
            bool member;
            if (!NativeMethods.CheckTokenMembership(token, bytes, out member))
            {
                throw Win32.LastError("Could not check the caller's groups");
            }
            return member;
        }

        private static byte[] Info(SafeAccessTokenHandle token, int infoClass)
        {
            byte[] buffer = new byte[1024];
            int returned;
            if (!NativeMethods.GetTokenInformation(token, infoClass, buffer, buffer.Length, out returned))
            {
                throw Win32.LastError("Could not read the caller's token");
            }
            return buffer;
        }

        /// <summary>The SID of a TOKEN_USER or TOKEN_MANDATORY_LABEL (a SID_AND_ATTRIBUTES pointing into the same buffer).</summary>
        private static SecurityIdentifier SidIn(SafeAccessTokenHandle token, int infoClass)
        {
            IntPtr buffer = Marshal.AllocHGlobal(1024);
            try
            {
                int returned;
                if (!NativeMethods.GetTokenInformationPtr(token, infoClass, buffer, 1024, out returned))
                {
                    throw Win32.LastError("Could not read the caller's token");
                }
                return new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static SecurityIdentifier ProcessUser(uint pid, out string program)
        {
            program = "";
            IntPtr process = NativeMethods.OpenProcess(ProcessQueryLimited, false, pid);
            if (process == IntPtr.Zero)
            {
                return null;
            }
            try
            {
                StringBuilder name = new StringBuilder(1024);
                uint size = (uint)name.Capacity;
                if (NativeMethods.QueryFullProcessImageNameW(process, 0, name, ref size))
                {
                    program = name.ToString();
                }
                SafeAccessTokenHandle token;
                if (!NativeMethods.OpenProcessToken(process, TokenQuery, out token))
                {
                    return null;
                }
                using (token)
                {
                    return UserOf(token);
                }
            }
            finally
            {
                NativeMethods.CloseHandle(process);
            }
        }

        public static SecurityIdentifier UserOf(SafeAccessTokenHandle token)
        {
            return new WindowsIdentity(token.DangerousGetHandle()).User;
        }

        public void Dispose()
        {
            Token.Dispose();
        }
    }
}
