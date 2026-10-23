// The service's log: one line per call (when, who, what, the result), in %ProgramData%\AgentSandbox\logs\
// storage-helper.log. The folder must belong to administrators with nobody else allowed to change it, and must be
// exactly where it says (no link on the way); otherwise the service does not start, since it writes there as SYSTEM.
// The file is opened without following links and must have one name only; past 1 MB it is renamed (by its handle) to
// storage-helper.log.1. Text from outside (a set name, a path, a reason) is reduced to printable ASCII first. Writing
// never throws: a full disk must not change what a call does.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public sealed class Log
    {
        private const long MaxBytes = 1024 * 1024;
        private const uint OpenAlways = 4;
        private const uint FileAppendData = 0x0004;
        private const int FileRenameInfoClass = 3;
        private static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
        private static readonly SecurityIdentifier AdministratorsSid = new SecurityIdentifier("S-1-5-32-544");
        private readonly object gate = new object();
        private readonly string file;

        private Log(string file)
        {
            this.file = file;
        }

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern SafeFileHandle CreateFileW(string fileName, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, byte[] info, int size);
        }

        /// <summary>The log in this folder (made, admin-only, when missing). Throws when the folder is not safe to write as SYSTEM.</summary>
        public static Log InFolder(string folder, bool requireAdminOnly)
        {
            if (!Directory.Exists(folder))
            {
                DirectorySecurity security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                security.AddAccessRule(new FileSystemAccessRule(AdministratorsSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(folder, security);
            }
            using (SafeFileHandle h = Win32.OpenNoFollow(folder, Win32.ReadControl | Win32.FileReadAttributes | Win32.Synchronize, Win32.FileShareRead | Win32.FileShareWrite))
            {
                if (h == null)
                {
                    throw new IOException("The log folder could not be made: " + folder);
                }
                Win32.ByHandleFileInformation info = Win32.InfoOf(h, folder);
                if ((info.FileAttributes & Win32.AttributeReparsePoint) != 0 || !Win32.IsAt(h, folder))
                {
                    throw new IOException("The log folder is a link or behind one: " + folder);
                }
                if (requireAdminOnly)
                {
                    RawSecurityDescriptor sd = Win32.SecurityOf(h);
                    bool adminOwned = sd.Owner != null && (sd.Owner.Equals(SystemSid) || sd.Owner.Equals(AdministratorsSid));
                    if (!adminOwned || Pins.OthersWhoMayChange(sd, SystemSid) != null)
                    {
                        throw new IOException("Someone who is not an administrator may change the log folder " + folder + "; run the installer again.");
                    }
                }
            }
            return new Log(Path.Combine(folder, "storage-helper.log"));
        }

        public string File
        {
            get { return file; }
        }

        public void Write(string sid, string account, int pid, string program, string verb, string set, string result)
        {
            string line = Now() +
                " sid=" + Safe.Text(sid, 200) +
                " user=" + Quote(account, 200) +
                " pid=" + pid +
                " program=" + Quote(program, 300) +
                " verb=" + Safe.Text(verb, 20) +
                " set=" + Quote(set, 80) +
                " result=" + Quote(result, 600);
            Append(line);
        }

        public void Note(string text)
        {
            Append(Now() + " " + Quote(text, 600));
        }

        private static string Now()
        {
            return DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
        }

        private static string Quote(string text, int max)
        {
            return "\"" + Safe.Text(text, max).Replace("\"", "'") + "\"";
        }

        private void Append(string line)
        {
            lock (gate)
            {
                try
                {
                    using (SafeFileHandle h = OpenLog(FileAppendData | Win32.FileReadAttributes | Win32.Synchronize | Win32.Delete))
                    {
                        Win32.ByHandleFileInformation info = Win32.InfoOf(h, file);
                        long size = ((long)info.FileSizeHigh << 32) | info.FileSizeLow;
                        if (size > MaxBytes)
                        {
                            RenameTo(h, file + ".1");
                        }
                    }
                    using (SafeFileHandle h = OpenLog(FileAppendData | Win32.FileReadAttributes | Win32.Synchronize))
                    using (FileStream stream = new FileStream(h, FileAccess.Write))
                    {
                        byte[] bytes = Encoding.ASCII.GetBytes(line + "\r\n");
                        stream.Seek(0, SeekOrigin.End);
                        stream.Write(bytes, 0, bytes.Length);
                    }
                }
                catch (Exception)
                {
                    // The log is a record, not a gate: a full disk or a locked file must not change what the call does.
                }
            }
        }

        /// <summary>The log file, made when missing, never through a link, never a file with a second name.</summary>
        private SafeFileHandle OpenLog(uint access)
        {
            SafeFileHandle h = NativeMethods.CreateFileW(file, access, Win32.FileShareRead, IntPtr.Zero, OpenAlways, Win32.FlagOpenReparsePoint, IntPtr.Zero);
            if (h.IsInvalid)
            {
                Win32Exception e = Win32.LastError("Could not open the log");
                h.Dispose();
                throw e;
            }
            Win32.ByHandleFileInformation info = Win32.InfoOf(h, file);
            if ((info.FileAttributes & (Win32.AttributeReparsePoint | Win32.AttributeDirectory)) != 0 || info.NumberOfLinks != 1)
            {
                h.Dispose();
                throw new IOException("The log is a link or has a second name; not writing to it.");
            }
            return h;
        }

        private static void RenameTo(SafeFileHandle h, string target)
        {
            // FILE_RENAME_INFO: BOOLEAN ReplaceIfExists; HANDLE RootDirectory; DWORD FileNameLength; WCHAR FileName[].
            byte[] name = Encoding.Unicode.GetBytes(target);
            int pointer = IntPtr.Size;
            int nameOffset = pointer * 2 + 4;
            byte[] info = new byte[nameOffset + name.Length + 2];
            info[0] = 1;
            BitConverter.GetBytes(name.Length).CopyTo(info, pointer * 2);
            name.CopyTo(info, nameOffset);
            if (!NativeMethods.SetFileInformationByHandle(h, FileRenameInfoClass, info, info.Length))
            {
                throw Win32.LastError("Could not rotate the log");
            }
        }
    }
}
