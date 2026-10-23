// The disk and volume work after an image is attached, all by disk number, volume name and folder handle (no path is
// looked up again): which volumes are on the disk, its partitions, whether Windows keeps it offline, a new disk's one
// GPT partition and NTFS format, drive letters to take away, and the mount point itself, written on the pinned mount
// folder's handle (a folder swapped for a link cannot receive it). Layouts from the Microsoft winioctl.h reference.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace AgentSandbox.StorageHelper
{
    public static class Volumes
    {
        private const uint IoctlVolumeGetDiskExtents = 0x00560000;
        private const uint IoctlDiskGetDriveLayoutEx = 0x00070050;
        private const uint IoctlDiskSetDriveLayoutEx = 0x0007C054;
        private const uint IoctlDiskCreateDisk = 0x0007C058;
        private const uint IoctlDiskUpdateProperties = 0x00070140;
        private const uint IoctlDiskGetDiskAttributes = 0x000700F0;
        private const uint IoctlDiskSetDiskAttributes = 0x0007C0F4;
        private const uint FsctlSetReparsePoint = 0x000900A4;
        private const uint FsctlGetReparsePoint = 0x000900A8;
        private const uint FsctlDeleteReparsePoint = 0x000900AC;
        private const uint TagMountPoint = 0xA0000003;
        private const ulong DiskAttributeOffline = 0x1;
        private const ulong DiskAttributeReadOnly = 0x2;
        private const int PartitionStyleMbr = 0;
        private const int PartitionStyleGpt = 1;
        private const int LayoutHeader = 48;
        private const int PartitionEntry = 144;
        private const long Alignment = 1024 * 1024;
        private const int FmifsHardDisk = 0xC;
        private const int FmifsDone = 0xB;
        private static readonly Guid BasicData = new Guid("EBD0A0A2-B9E5-4433-87C0-68B6B72699C7");

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        [return: MarshalAs(UnmanagedType.U1)]
        private delegate bool FormatCallback(int command, int subAction, IntPtr info);

        private static class NativeMethods
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr FindFirstVolumeW(StringBuilder name, uint size);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool FindNextVolumeW(IntPtr find, StringBuilder name, uint size);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool FindVolumeClose(IntPtr find);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetVolumePathNamesForVolumeNameW(string volume, char[] names, uint size, out uint needed);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool DeleteVolumeMountPointW(string mountPoint);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetVolumeInformationW(string root, StringBuilder volumeName, uint volumeNameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fileSystem, uint fileSystemSize);

            [DllImport("fmifs.dll", CharSet = CharSet.Unicode)]
            public static extern void FormatEx(string driveRoot, int mediaType, string fileSystem, string label, [MarshalAs(UnmanagedType.U1)] bool quick, int clusterSize, FormatCallback callback);
        }

        /// <summary>The volumes (\\?\Volume{...}\) that lie on this disk.</summary>
        public static List<string> OnDisk(int disk)
        {
            List<string> found = new List<string>();
            StringBuilder name = new StringBuilder(64);
            IntPtr find = NativeMethods.FindFirstVolumeW(name, (uint)name.Capacity);
            if (find == new IntPtr(-1))
            {
                throw Win32.LastError("Could not list the volumes");
            }
            try
            {
                do
                {
                    string volume = name.ToString();
                    if (DisksOf(volume).Contains(disk))
                    {
                        found.Add(volume);
                    }
                    name.Length = 0;
                }
                while (NativeMethods.FindNextVolumeW(find, name, (uint)name.Capacity));
            }
            finally
            {
                NativeMethods.FindVolumeClose(find);
            }
            return found;
        }

        /// <summary>The disk numbers a volume lies on (empty when it cannot be asked, e.g. a CD drive without a disc).</summary>
        public static List<int> DisksOf(string volume)
        {
            List<int> disks = new List<int>();
            using (SafeFileHandle h = Win32.NativeMethods.CreateFileW(volume.TrimEnd('\\'), 0, Win32.FileShareRead | Win32.FileShareWrite, IntPtr.Zero, Win32.OpenExisting, 0, IntPtr.Zero))
            {
                if (h.IsInvalid)
                {
                    return disks;
                }
                byte[] output = new byte[8 + 24 * 32];
                int returned;
                if (Win32.TryIoctl(h, IoctlVolumeGetDiskExtents, null, output, out returned) != 0)
                {
                    return disks;
                }
                int count = Math.Min(BitConverter.ToInt32(output, 0), 32);
                for (int i = 0; i < count; i++)
                {
                    disks.Add(BitConverter.ToInt32(output, 8 + 24 * i));
                }
            }
            return disks;
        }

        /// <summary>Waits until exactly `count` volumes are on the disk (a new or attached disk takes a moment).</summary>
        public static List<string> WaitFor(int disk, int count, TimeSpan timeout)
        {
            DateTime until = DateTime.UtcNow + timeout;
            List<string> volumes;
            while (true)
            {
                volumes = OnDisk(disk);
                if (volumes.Count >= count || DateTime.UtcNow > until)
                {
                    return volumes;
                }
                Thread.Sleep(250);
            }
        }

        private static SafeFileHandle OpenDisk(int disk)
        {
            SafeFileHandle h = Win32.NativeMethods.CreateFileW("\\\\.\\PhysicalDrive" + disk, Win32.GenericRead | Win32.GenericWrite, Win32.FileShareRead | Win32.FileShareWrite, IntPtr.Zero, Win32.OpenExisting, 0, IntPtr.Zero);
            if (h.IsInvalid)
            {
                Win32Exception e = Win32.LastError("Could not open the attached disk");
                h.Dispose();
                throw e;
            }
            return h;
        }

        /// <summary>How many partitions with a size the disk has.</summary>
        public static int PartitionCount(int disk)
        {
            using (SafeFileHandle h = OpenDisk(disk))
            {
                byte[] layout = new byte[LayoutHeader + PartitionEntry * 128];
                Win32.Ioctl(h, IoctlDiskGetDriveLayoutEx, null, layout, "Could not read the disk's partitions");
                int style = BitConverter.ToInt32(layout, 0);
                int count = Math.Min(BitConverter.ToInt32(layout, 4), 128);
                int used = 0;
                for (int i = 0; i < count; i++)
                {
                    int at = LayoutHeader + PartitionEntry * i;
                    long length = BitConverter.ToInt64(layout, at + 16);
                    bool typed = style == PartitionStyleGpt ? new Guid(Slice(layout, at + 32, 16)) != Guid.Empty : layout[at + 32] != 0;
                    if (length > 0 && typed)
                    {
                        used++;
                    }
                }
                return used;
            }
        }

        /// <summary>True when Windows keeps the disk offline (e.g. it has the same id as another disk) or read-only.</summary>
        public static bool IsOfflineOrReadOnly(int disk)
        {
            using (SafeFileHandle h = OpenDisk(disk))
            {
                byte[] output = new byte[16];
                Win32.Ioctl(h, IoctlDiskGetDiskAttributes, null, output, "Could not read the disk's state");
                ulong attributes = BitConverter.ToUInt64(output, 8);
                return (attributes & (DiskAttributeOffline | DiskAttributeReadOnly)) != 0;
            }
        }

        /// <summary>A brand-new disk (made by this service): online, one GPT basic data partition over all of it.</summary>
        public static void Partition(int disk)
        {
            using (SafeFileHandle h = OpenDisk(disk))
            {
                byte[] attributes = new byte[16];
                Win32.Ioctl(h, IoctlDiskGetDiskAttributes, null, attributes, "Could not read the disk's state");
                if ((BitConverter.ToUInt64(attributes, 8) & (DiskAttributeOffline | DiskAttributeReadOnly)) != 0)
                {
                    byte[] set = new byte[40];
                    BitConverter.GetBytes(40).CopyTo(set, 0);
                    BitConverter.GetBytes(0UL).CopyTo(set, 8);
                    BitConverter.GetBytes(DiskAttributeOffline | DiskAttributeReadOnly).CopyTo(set, 16);
                    Win32.Ioctl(h, IoctlDiskSetDiskAttributes, set, null, "Could not bring the new disk online");
                }
                byte[] create = new byte[24];
                BitConverter.GetBytes(PartitionStyleGpt).CopyTo(create, 0);
                Guid.NewGuid().ToByteArray().CopyTo(create, 4);
                BitConverter.GetBytes(128).CopyTo(create, 20);
                Win32.Ioctl(h, IoctlDiskCreateDisk, create, null, "Could not initialize the new disk");

                byte[] layout = new byte[LayoutHeader + PartitionEntry * 128];
                Win32.Ioctl(h, IoctlDiskGetDriveLayoutEx, null, layout, "Could not read the new disk's layout");
                if (BitConverter.ToInt32(layout, 0) != PartitionStyleGpt)
                {
                    throw new InvalidOperationException("The new disk did not become a GPT disk.");
                }
                long usableStart = BitConverter.ToInt64(layout, 8 + 16);
                long usableLength = BitConverter.ToInt64(layout, 8 + 24);
                long start = (usableStart + Alignment - 1) / Alignment * Alignment;
                long end = (usableStart + usableLength) / Alignment * Alignment;
                if (end - start < 512 * Alignment)
                {
                    throw new InvalidOperationException("The new disk is too small.");
                }
                byte[] set2 = new byte[LayoutHeader + PartitionEntry];
                Array.Copy(layout, 0, set2, 0, LayoutHeader);
                BitConverter.GetBytes(1).CopyTo(set2, 4);
                int at = LayoutHeader;
                BitConverter.GetBytes(PartitionStyleGpt).CopyTo(set2, at);
                BitConverter.GetBytes(start).CopyTo(set2, at + 8);
                BitConverter.GetBytes(end - start).CopyTo(set2, at + 16);
                BitConverter.GetBytes(1).CopyTo(set2, at + 24);
                set2[at + 28] = 1;
                BasicData.ToByteArray().CopyTo(set2, at + 32);
                Guid.NewGuid().ToByteArray().CopyTo(set2, at + 48);
                Encoding.Unicode.GetBytes("AgentData").CopyTo(set2, at + 72);
                Win32.Ioctl(h, IoctlDiskSetDriveLayoutEx, set2, null, "Could not make the partition");
                Win32.Ioctl(h, IoctlDiskUpdateProperties, null, null, "Could not refresh the disk");
            }
        }

        /// <summary>Quick NTFS format of a volume of the new disk (fmifs, what format.com uses).</summary>
        public static void Format(string volume, string label)
        {
            bool done = false;
            bool ok = false;
            StringBuilder seen = new StringBuilder();
            FormatCallback callback = delegate(int command, int subAction, IntPtr info)
            {
                if (command != 0 && seen.Length < 200)
                {
                    seen.Append(command).Append(' ');
                }
                if (command == FmifsDone)
                {
                    done = true;
                    ok = info != IntPtr.Zero && Marshal.ReadByte(info) != 0;
                }
                return true;
            };
            // fmifs takes the volume name without its trailing backslash (with it, it fails at once).
            NativeMethods.FormatEx(volume.TrimEnd('\\'), FmifsHardDisk, "NTFS", label, true, 0, callback);
            GC.KeepAlive(callback);
            if (!done || !ok)
            {
                throw new InvalidOperationException("Formatting the new disk failed (steps: " + seen.ToString().Trim() + ").");
            }
        }

        public static string FileSystemOf(string volume)
        {
            StringBuilder name = new StringBuilder(261);
            StringBuilder fs = new StringBuilder(261);
            uint serial;
            uint max;
            uint flags;
            if (!NativeMethods.GetVolumeInformationW(volume.EndsWith("\\") ? volume : volume + "\\", name, (uint)name.Capacity, out serial, out max, out flags, fs, (uint)fs.Capacity))
            {
                return "";
            }
            return fs.ToString();
        }

        /// <summary>Takes away any drive letter Windows gave the volume anyway (it can remember one for a disk it saw before).</summary>
        public static void RemoveDriveLetters(string volume)
        {
            char[] buffer = new char[4096];
            uint needed;
            if (!NativeMethods.GetVolumePathNamesForVolumeNameW(volume, buffer, (uint)buffer.Length, out needed))
            {
                return;
            }
            foreach (string path in new string(buffer, 0, (int)Math.Min(needed, (uint)buffer.Length)).Split('\0'))
            {
                if (path.Length == 3 && path[1] == ':' && path[2] == '\\')
                {
                    if (!NativeMethods.DeleteVolumeMountPointW(path))
                    {
                        throw Win32.LastError("Could not take the drive letter " + path + " away from the image");
                    }
                }
            }
        }

        /// <summary>The volume (\\?\Volume{...}\) a mount-point folder points to; null when the folder is no mount point.</summary>
        public static string MountTarget(SafeFileHandle folder)
        {
            byte[] buffer = new byte[16 * 1024];
            int returned;
            int error = Win32.TryIoctl(folder, FsctlGetReparsePoint, null, buffer, out returned);
            if (error != 0)
            {
                return null;
            }
            if (BitConverter.ToUInt32(buffer, 0) != TagMountPoint)
            {
                throw new RefusedException("The mount folder is a link, not a mount point; not touching it.");
            }
            int offset = BitConverter.ToUInt16(buffer, 8);
            int length = BitConverter.ToUInt16(buffer, 10);
            if (16 + offset + length > returned)
            {
                throw new RefusedException("The mount folder has a damaged mount point.");
            }
            string target = Encoding.Unicode.GetString(buffer, 16 + offset, length);
            if (target.StartsWith("\\??\\Volume{", StringComparison.OrdinalIgnoreCase))
            {
                return "\\\\?\\" + target.Substring(4).TrimEnd('\\') + "\\";
            }
            throw new RefusedException("The mount folder points somewhere that is not a volume; not touching it.");
        }

        /// <summary>Makes the (empty, pinned) folder a mount point of the volume, through its handle.</summary>
        public static void SetMountPoint(SafeFileHandle folder, string volume)
        {
            if (!volume.StartsWith("\\\\?\\Volume{", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Not a volume name: " + Safe.Text(volume, 100));
            }
            byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + volume.Substring(4).TrimEnd('\\') + "\\");
            byte[] print = new byte[0];
            int pathBytes = substitute.Length + 2 + print.Length + 2;
            byte[] data = new byte[16 + pathBytes];
            BitConverter.GetBytes(TagMountPoint).CopyTo(data, 0);
            BitConverter.GetBytes((ushort)(8 + pathBytes)).CopyTo(data, 4);
            BitConverter.GetBytes((ushort)0).CopyTo(data, 8);
            BitConverter.GetBytes((ushort)substitute.Length).CopyTo(data, 10);
            BitConverter.GetBytes((ushort)(substitute.Length + 2)).CopyTo(data, 12);
            BitConverter.GetBytes((ushort)print.Length).CopyTo(data, 14);
            substitute.CopyTo(data, 16);
            Win32.Ioctl(folder, FsctlSetReparsePoint, data, null, "Could not make the mount folder a mount point");
        }

        /// <summary>Takes the mount point off the (pinned) folder through its handle; the folder stays, empty.</summary>
        public static void RemoveMountPoint(SafeFileHandle folder)
        {
            byte[] header = new byte[8];
            BitConverter.GetBytes(TagMountPoint).CopyTo(header, 0);
            Win32.Ioctl(folder, FsctlDeleteReparsePoint, header, null, "Could not take the mount point off the mount folder");
        }

        /// <summary>Is any volume with this name present on the PC now?</summary>
        public static bool Exists(string volume)
        {
            using (SafeFileHandle h = Win32.NativeMethods.CreateFileW(volume.TrimEnd('\\'), 0, Win32.FileShareRead | Win32.FileShareWrite, IntPtr.Zero, Win32.OpenExisting, 0, IntPtr.Zero))
            {
                return !h.IsInvalid;
            }
        }

        private static byte[] Slice(byte[] bytes, int offset, int count)
        {
            byte[] part = new byte[count];
            Array.Copy(bytes, offset, part, 0, count);
            return part;
        }
    }
}
