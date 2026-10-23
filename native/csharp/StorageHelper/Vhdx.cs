// Reads the VHDX header of an image through a stream the caller opened (the layout is in the VHDX specification), the
// same reading as Read-VhdxInfo in native\scripts\contained-common.ps1: is it a VHDX, how big may it grow, does it have
// a parent (a differencing disk would reach into another file)? It also reads the current header (the valid one with
// the higher sequence number, checksum CRC-32C) to see whether it names a log the disk driver would replay.
using System;
using System.IO;
using System.Text;

namespace AgentSandbox.StorageHelper
{
    public sealed class VhdxInfo
    {
        public VhdxInfo(ulong virtualSize, bool hasParent, bool hasLog)
        {
            VirtualSize = virtualSize;
            HasParent = hasParent;
            HasLog = hasLog;
        }

        public ulong VirtualSize { get; private set; }
        public bool HasParent { get; private set; }

        /// <summary>The current header names a log to replay (the image was not closed cleanly, or the log was written by hand).</summary>
        public bool HasLog { get; private set; }
    }

    public static class Vhdx
    {
        private const long RegionTableOffset = 196608;
        private const long Header1Offset = 65536;
        private const long Header2Offset = 131072;
        private const int HeaderBytes = 4096;
        private const int TableBytes = 65536;
        private const int MaxRegions = 64;
        private const int MaxMetadataItems = 2047;
        private static readonly Guid MetadataRegion = new Guid("8b7ca206-4790-4b9a-b8fe-575f050f886e");
        private static readonly Guid VirtualSizeItem = new Guid("2fa54224-cd1b-4876-b211-5dbed83bf4b8");
        private static readonly Guid ParentItem = new Guid("a8d35f2d-b30b-454d-abf7-d3d84834ab0c");

        public static VhdxInfo Read(Stream stream)
        {
            if (Encoding.ASCII.GetString(ReadExact(stream, 0, 8)) != "vhdxfile")
            {
                throw new RefusedException("The file is not a VHDX image.");
            }
            byte[] table = ReadExact(stream, RegionTableOffset, TableBytes);
            if (Encoding.ASCII.GetString(table, 0, 4) != "regi")
            {
                throw new RefusedException("The image has no region table.");
            }
            uint count = BitConverter.ToUInt32(table, 8);
            if (count > MaxRegions)
            {
                throw new RefusedException("The image has too many regions.");
            }
            long metadataOffset = -1;
            for (int i = 0; i < count; i++)
            {
                int at = 16 + 32 * i;
                if (GuidAt(table, at) == MetadataRegion)
                {
                    ulong offset = BitConverter.ToUInt64(table, at + 16);
                    if (offset > long.MaxValue)
                    {
                        throw new RefusedException("The image is not a valid VHDX file (a part is missing).");
                    }
                    metadataOffset = (long)offset;
                }
            }
            if (metadataOffset < 0)
            {
                throw new RefusedException("The image has no metadata region.");
            }
            byte[] meta = ReadExact(stream, metadataOffset, TableBytes);
            if (Encoding.ASCII.GetString(meta, 0, 8) != "metadata")
            {
                throw new RefusedException("The image has no metadata table.");
            }
            int items = BitConverter.ToUInt16(meta, 10);
            if (items > MaxMetadataItems)
            {
                throw new RefusedException("The image has too many metadata items.");
            }
            ulong size = 0;
            bool hasParent = false;
            for (int i = 0; i < items; i++)
            {
                int at = 32 + 32 * i;
                Guid id = GuidAt(meta, at);
                if (id == ParentItem)
                {
                    hasParent = true;
                }
                if (id == VirtualSizeItem)
                {
                    long itemOffset = BitConverter.ToUInt32(meta, at + 16);
                    size = BitConverter.ToUInt64(ReadExact(stream, metadataOffset + itemOffset, 8), 0);
                }
            }
            return new VhdxInfo(size, hasParent, CurrentHeaderHasLog(stream));
        }

        private static bool CurrentHeaderHasLog(Stream stream)
        {
            byte[] best = null;
            ulong bestSequence = 0;
            foreach (long offset in new long[] { Header1Offset, Header2Offset })
            {
                byte[] header = ReadExact(stream, offset, HeaderBytes);
                if (Encoding.ASCII.GetString(header, 0, 4) != "head" || !ChecksumOk(header))
                {
                    continue;
                }
                ulong sequence = BitConverter.ToUInt64(header, 8);
                if (best == null || sequence > bestSequence)
                {
                    best = header;
                    bestSequence = sequence;
                }
            }
            if (best == null)
            {
                throw new RefusedException("The image has no valid header.");
            }
            for (int i = 48; i < 64; i++)
            {
                if (best[i] != 0)
                {
                    return true;
                }
            }
            return false;
        }

        private static bool ChecksumOk(byte[] header)
        {
            uint stored = BitConverter.ToUInt32(header, 4);
            byte[] copy = (byte[])header.Clone();
            copy[4] = 0;
            copy[5] = 0;
            copy[6] = 0;
            copy[7] = 0;
            return Crc32C(copy) == stored;
        }

        private static uint[] crcTable;

        public static uint Crc32C(byte[] data)
        {
            uint[] table = crcTable;
            if (table == null)
            {
                table = new uint[256];
                for (uint i = 0; i < 256; i++)
                {
                    uint c = i;
                    for (int k = 0; k < 8; k++)
                    {
                        c = (c & 1) != 0 ? 0x82F63B78u ^ (c >> 1) : c >> 1;
                    }
                    table[i] = c;
                }
                crcTable = table;
            }
            uint crc = 0xFFFFFFFFu;
            foreach (byte b in data)
            {
                crc = table[(crc ^ b) & 0xFF] ^ (crc >> 8);
            }
            return crc ^ 0xFFFFFFFFu;
        }

        /// <summary>Refuses a differencing disk, an unreadable size and one bigger than the limit.</summary>
        public static void CheckPlain(VhdxInfo info, long maxGb)
        {
            if (info.HasParent)
            {
                throw new RefusedException("The image is a differencing disk (it has a parent file); refusing it.");
            }
            if (info.HasLog)
            {
                throw new LogPendingException();
            }
            if (info.VirtualSize == 0)
            {
                throw new RefusedException("The image size could not be read.");
            }
            if (info.VirtualSize > (ulong)maxGb * 1024UL * 1024UL * 1024UL)
            {
                throw new RefusedException("The image is bigger than the limit of " + maxGb + " GB.");
            }
        }

        private static Guid GuidAt(byte[] bytes, int offset)
        {
            byte[] part = new byte[16];
            Array.Copy(bytes, offset, part, 0, 16);
            return new Guid(part);
        }

        private static byte[] ReadExact(Stream stream, long offset, int count)
        {
            if (offset < 0 || offset > stream.Length - count)
            {
                throw new RefusedException("The image is not a valid VHDX file (a part is missing).");
            }
            stream.Seek(offset, SeekOrigin.Begin);
            byte[] buffer = new byte[count];
            int done = 0;
            while (done < count)
            {
                int n = stream.Read(buffer, done, count - done);
                if (n <= 0)
                {
                    throw new RefusedException("The image could not be read.");
                }
                done += n;
            }
            return buffer;
        }
    }

    /// <summary>The image names a log to replay: this service does not let the disk driver replay it (the UAC path may).</summary>
    public sealed class LogPendingException : Exception
    {
        public LogPendingException() : base("The image was not closed cleanly (its log has changes to replay), so the helper leaves it to the Windows permission prompt.")
        {
        }
    }
}
