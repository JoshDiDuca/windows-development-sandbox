// One VHDX through virtdisk.dll, held by its handle from the open to the attach: open it (never its parents), ask the
// disk driver what it is (VHDX, not a differencing disk, its size), attach it without drive letters for good (until a
// detach or a restart), detach it. A new image is made with CreateVirtualDisk, which refuses a file that exists, with
// the user as its owner. Signatures from the Microsoft virtdisk.h reference.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentSandbox.StorageHelper
{
    public sealed class VirtualDisk : IDisposable
    {
        private const uint DeviceVhdx = 3;
        private static readonly Guid VendorMicrosoft = new Guid("EC984AEC-A0F9-47e9-901F-71415A66345B");
        private const uint AccessAttachRw = 0x00020000;
        private const uint AccessDetach = 0x00040000;
        private const uint AccessGetInfo = 0x00080000;
        private const uint AccessAll = 0x003f0000;
        private const uint OpenFlagNoParents = 0x1;
        private const uint OpenVersion1 = 1;
        private const uint CreateVersion1 = 1;
        private const uint AttachVersion1 = 1;
        private const uint AttachNoDriveLetter = 0x2;
        private const uint AttachPermanentLifetime = 0x4;
        private const uint InfoSize = 1;
        private const uint InfoStorageType = 6;
        private const uint InfoProviderSubtype = 7;
        private const uint SubtypeDifferencing = 4;
        private const int ErrorFileExists = 80;
        private const int ErrorAlreadyExists = 183;
        private const int ErrorNotReady = 21;
        private const int ErrorDevNotExist = 55;
        private const int ErrorVirtualDiskNotAttached = unchecked((int)0xC03A0015);

        private IntPtr handle;

        private VirtualDisk(IntPtr handle)
        {
            this.handle = handle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StorageType
        {
            public uint DeviceId;
            public Guid VendorId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct OpenParametersV1
        {
            public uint Version;
            public uint RwDepth;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CreateParametersV1
        {
            public uint Version;
            public Guid UniqueId;
            public ulong MaximumSize;
            public uint BlockSizeInBytes;
            public uint SectorSizeInBytes;
            public IntPtr ParentPath;
            public IntPtr SourcePath;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct AttachParametersV1
        {
            public uint Version;
            public uint Reserved;
        }

        private static class NativeMethods
        {
            [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
            public static extern int OpenVirtualDisk(ref StorageType storageType, string path, uint accessMask, uint flags, ref OpenParametersV1 parameters, out IntPtr handle);

            [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
            public static extern int CreateVirtualDisk(ref StorageType storageType, string path, uint accessMask, byte[] securityDescriptor, uint flags, uint providerSpecificFlags, ref CreateParametersV1 parameters, IntPtr overlapped, out IntPtr handle);

            [DllImport("virtdisk.dll")]
            public static extern int AttachVirtualDisk(IntPtr handle, IntPtr securityDescriptor, uint flags, uint providerSpecificFlags, ref AttachParametersV1 parameters, IntPtr overlapped);

            [DllImport("virtdisk.dll")]
            public static extern int DetachVirtualDisk(IntPtr handle, uint flags, uint providerSpecificFlags);

            [DllImport("virtdisk.dll")]
            public static extern int GetVirtualDiskInformation(IntPtr handle, ref uint size, byte[] info, IntPtr used);

            [DllImport("virtdisk.dll", CharSet = CharSet.Unicode)]
            public static extern int GetVirtualDiskPhysicalPath(IntPtr handle, ref uint size, StringBuilder path);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);
        }

        private static StorageType Vhdx()
        {
            StorageType type = new StorageType();
            type.DeviceId = DeviceVhdx;
            type.VendorId = VendorMicrosoft;
            return type;
        }

        /// <summary>Opens an existing VHDX for attach, detach and questions; its parents (if any) are never opened.</summary>
        public static VirtualDisk Open(string path)
        {
            StorageType type = Vhdx();
            OpenParametersV1 parameters = new OpenParametersV1();
            parameters.Version = OpenVersion1;
            parameters.RwDepth = 1;
            IntPtr h;
            int error = NativeMethods.OpenVirtualDisk(ref type, path, AccessAttachRw | AccessDetach | AccessGetInfo, OpenFlagNoParents, ref parameters, out h);
            if (error != 0)
            {
                throw new Win32Exception(error, "Could not open the image: " + new Win32Exception(error).Message);
            }
            return new VirtualDisk(h);
        }

        /// <summary>Makes a new dynamic VHDX (refused when any file is there) with this security descriptor, and keeps it open.</summary>
        public static VirtualDisk Create(string path, long maxGb, byte[] securityDescriptor)
        {
            StorageType type = Vhdx();
            CreateParametersV1 parameters = new CreateParametersV1();
            parameters.Version = CreateVersion1;
            parameters.MaximumSize = (ulong)maxGb * 1024UL * 1024UL * 1024UL;
            IntPtr h;
            int error = NativeMethods.CreateVirtualDisk(ref type, path, AccessAll, securityDescriptor, 0, 0, ref parameters, IntPtr.Zero, out h);
            if (error == ErrorFileExists || error == ErrorAlreadyExists)
            {
                throw new RefusedException("An image exists already; refusing to create over it: " + path);
            }
            if (error != 0)
            {
                throw new Win32Exception(error, "Could not create the image: " + new Win32Exception(error).Message);
            }
            return new VirtualDisk(h);
        }

        /// <summary>What the disk driver says: a VHDX, not a differencing disk (provider subtype 4), its size.</summary>
        public void CheckPlain(long maxGb)
        {
            byte[] type = Info(InfoStorageType);
            if (BitConverter.ToUInt32(type, 8) != DeviceVhdx)
            {
                throw new RefusedException("The image is not a VHDX disk.");
            }
            if (BitConverter.ToUInt32(Info(InfoProviderSubtype), 8) == SubtypeDifferencing)
            {
                throw new RefusedException("The image is a differencing disk (it has a parent file); refusing it.");
            }
            ulong size = BitConverter.ToUInt64(Info(InfoSize), 8);
            if (size == 0 || size > (ulong)maxGb * 1024UL * 1024UL * 1024UL)
            {
                throw new RefusedException("The image is bigger than the limit of " + maxGb + " GB.");
            }
        }

        private byte[] Info(uint version)
        {
            byte[] buffer = new byte[1024];
            BitConverter.GetBytes(version).CopyTo(buffer, 0);
            uint size = (uint)buffer.Length;
            int error = NativeMethods.GetVirtualDiskInformation(handle, ref size, buffer, IntPtr.Zero);
            if (error != 0)
            {
                throw new Win32Exception(error, "Could not read the image's details: " + new Win32Exception(error).Message);
            }
            return buffer;
        }

        /// <summary>\\.\PhysicalDriveN while attached; null when it is not attached.</summary>
        public string PhysicalPath()
        {
            StringBuilder sb = new StringBuilder(260);
            uint size = (uint)(sb.Capacity * 2);
            int error = NativeMethods.GetVirtualDiskPhysicalPath(handle, ref size, sb);
            if (error == 0)
            {
                return sb.ToString();
            }
            if (error == ErrorVirtualDiskNotAttached || error == ErrorNotReady || error == ErrorDevNotExist || (error & 0xFFFF) == 0x15)
            {
                return null;
            }
            throw new Win32Exception(error, "Could not tell whether the image is attached: " + new Win32Exception(error).Message);
        }

        /// <summary>The disk number of an attached image (from \\.\PhysicalDriveN), or -1.</summary>
        public int DiskNumber()
        {
            string path = PhysicalPath();
            if (path == null)
            {
                return -1;
            }
            const string Prefix = "\\\\.\\PhysicalDrive";
            int number;
            if (!path.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase) || !int.TryParse(path.Substring(Prefix.Length), out number))
            {
                throw new InvalidOperationException("Unexpected disk path: " + Safe.Text(path, 100));
            }
            return number;
        }

        /// <summary>Attaches until a detach or a restart (not only while this handle is open), with no drive letters.</summary>
        public void Attach()
        {
            AttachParametersV1 parameters = new AttachParametersV1();
            parameters.Version = AttachVersion1;
            int error = NativeMethods.AttachVirtualDisk(handle, IntPtr.Zero, AttachNoDriveLetter | AttachPermanentLifetime, 0, ref parameters, IntPtr.Zero);
            if (error != 0)
            {
                throw new Win32Exception(error, "Could not attach the image: " + new Win32Exception(error).Message);
            }
        }

        public void Detach()
        {
            int error = NativeMethods.DetachVirtualDisk(handle, 0, 0);
            if (error != 0)
            {
                throw new Win32Exception(error, "Could not detach the image (something may still use files in it): " + new Win32Exception(error).Message);
            }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1))
            {
                NativeMethods.CloseHandle(handle);
            }
            handle = IntPtr.Zero;
        }
    }
}
