// HostTools minidump <file>: reads a Windows minidump (what WER LocalDumps writes for vmwp.exe) without a debugger and
// prints what is needed to name the part of Windows that failed, as JSON. The file is data from a crashed program, so
// every size and offset in it is checked against the file's length and against the caps below. C# 5.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace AgentSandbox
{
    public static class MiniDump
    {
        private const long MaxFileBytes = 64L * 1024 * 1024;
        private const uint Signature = 0x504D444D;
        private const int HeaderBytes = 32;
        private const int DirectoryEntryBytes = 12;
        private const int MaxStreams = 1024;
        private const int MaxModules = 4096;
        private const int MaxThreads = 4096;
        private const int MaxMemoryRanges = 65536;
        private const int MaxNameBytes = 520;
        private const int MaxScanBytes = 128 * 1024;
        private const int MaxStackModules = 16;

        private const uint ThreadListStream = 3;
        private const uint ModuleListStream = 4;
        private const uint MemoryListStream = 5;
        private const uint ExceptionStream = 6;

        private const int ModuleEntryBytes = 108;
        private const int ThreadEntryBytes = 48;
        private const int MemoryEntryBytes = 16;
        private const int ExceptionStreamMinBytes = 32;
        // CONTEXT (x64): Rsp is at 0x98.
        private const int ContextRspOffset = 0x98;

        private sealed class Module
        {
            public ulong Base;
            public uint Size;
            public string Name;
            public string Version;
        }

        private sealed class Region
        {
            public ulong Start;
            public uint Size;
            public uint Rva;
        }

        /// <summary>The parsed dump as JSON; throws InvalidDataException for a file that is not a sound minidump.</summary>
        public static string Json(string path)
        {
            byte[] data = Read(path);
            if (data.Length < HeaderBytes || U32(data, 0) != Signature)
            {
                throw new InvalidDataException("not a minidump");
            }
            uint streamCount = U32(data, 8);
            uint directoryRva = U32(data, 12);
            if (streamCount > MaxStreams || !InRange(data, directoryRva, (long)streamCount * DirectoryEntryBytes))
            {
                throw new InvalidDataException("the stream directory is outside the file");
            }

            uint exceptionRva = 0, exceptionSize = 0, modulesRva = 0, modulesSize = 0;
            uint threadsRva = 0, threadsSize = 0, memoryRva = 0, memorySize = 0;
            for (uint i = 0; i < streamCount; i++)
            {
                long entry = directoryRva + (long)i * DirectoryEntryBytes;
                uint type = U32(data, entry);
                uint size = U32(data, entry + 4);
                uint rva = U32(data, entry + 8);
                if (!InRange(data, rva, size))
                {
                    continue;
                }
                if (type == ExceptionStream) { exceptionRva = rva; exceptionSize = size; }
                else if (type == ModuleListStream) { modulesRva = rva; modulesSize = size; }
                else if (type == ThreadListStream) { threadsRva = rva; threadsSize = size; }
                else if (type == MemoryListStream) { memoryRva = rva; memorySize = size; }
            }
            if (exceptionSize < ExceptionStreamMinBytes)
            {
                throw new InvalidDataException("the dump has no exception record");
            }

            List<Module> modules = ReadModules(data, modulesRva, modulesSize);
            uint threadId = U32(data, exceptionRva);
            uint code = U32(data, exceptionRva + 8);
            ulong address = U64(data, exceptionRva + 24);

            Module faulting = ModuleAt(modules, address);
            List<string> stackModules = new List<string>();
            ulong rsp = 0;
            // The thread context sits after the 15 exception parameters: size, rva.
            if (exceptionSize >= 168)
            {
                uint contextSize = U32(data, exceptionRva + 160);
                uint contextRva = U32(data, exceptionRva + 164);
                if (contextSize > ContextRspOffset + 8 && InRange(data, contextRva, contextSize))
                {
                    rsp = U64(data, contextRva + ContextRspOffset);
                }
            }
            Region stack = FindStack(data, threadsRva, threadsSize, memoryRva, memorySize, threadId, rsp);
            if (stack != null)
            {
                ScanStack(data, stack, rsp, modules, stackModules);
            }

            StringBuilder json = new StringBuilder();
            json.Append("{\"exceptionCode\":").Append(Quote("0x" + code.ToString("x8", CultureInfo.InvariantCulture)));
            json.Append(",\"exceptionAddress\":").Append(Quote("0x" + address.ToString("x", CultureInfo.InvariantCulture)));
            json.Append(",\"faultingModule\":").Append(faulting == null ? "null" : Quote(faulting.Name));
            json.Append(",\"faultingOffset\":").Append(faulting == null ? "null" : Quote("0x" + (address - faulting.Base).ToString("x", CultureInfo.InvariantCulture)));
            json.Append(",\"faultingVersion\":").Append(faulting == null || faulting.Version == null ? "null" : Quote(faulting.Version));
            json.Append(",\"stackModules\":[");
            for (int i = 0; i < stackModules.Count; i++)
            {
                json.Append(i == 0 ? "" : ",").Append(Quote(stackModules[i]));
            }
            json.Append("],\"modules\":").Append(modules.Count.ToString(CultureInfo.InvariantCulture)).Append("}");
            return json.ToString();
        }

        private static byte[] Read(string path)
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (stream.Length > MaxFileBytes)
                {
                    throw new InvalidDataException("the dump is larger than 64 MB");
                }
                byte[] data = new byte[(int)stream.Length];
                int done = 0;
                while (done < data.Length)
                {
                    int n = stream.Read(data, done, data.Length - done);
                    if (n <= 0)
                    {
                        break;
                    }
                    done += n;
                }
                if (done != data.Length)
                {
                    throw new InvalidDataException("the dump could not be read completely");
                }
                return data;
            }
        }

        private static List<Module> ReadModules(byte[] data, uint rva, uint size)
        {
            List<Module> modules = new List<Module>();
            if (size < 4)
            {
                return modules;
            }
            uint count = U32(data, rva);
            if (count > MaxModules || (long)count * ModuleEntryBytes + 4 > size)
            {
                throw new InvalidDataException("the module list is larger than its stream");
            }
            for (uint i = 0; i < count; i++)
            {
                long entry = rva + 4 + (long)i * ModuleEntryBytes;
                Module module = new Module();
                module.Base = U64(data, entry);
                module.Size = U32(data, entry + 8);
                module.Name = ReadName(data, U32(data, entry + 20));
                // VS_FIXEDFILEINFO: signature 0xFEEF04BD, then the file version.
                if (U32(data, entry + 24) == 0xFEEF04BD)
                {
                    uint ms = U32(data, entry + 32);
                    uint ls = U32(data, entry + 36);
                    module.Version = (ms >> 16) + "." + (ms & 0xFFFF) + "." + (ls >> 16) + "." + (ls & 0xFFFF);
                }
                modules.Add(module);
            }
            return modules;
        }

        /// <summary>A MINIDUMP_STRING (byte length, then UTF-16) reduced to its file name; "?" when it is out of bounds.</summary>
        private static string ReadName(byte[] data, uint rva)
        {
            if (!InRange(data, rva, 4))
            {
                return "?";
            }
            uint length = U32(data, rva);
            if (length > MaxNameBytes || !InRange(data, rva + 4, length))
            {
                return "?";
            }
            string name = Encoding.Unicode.GetString(data, (int)rva + 4, (int)length);
            int slash = Math.Max(name.LastIndexOf('\\'), name.LastIndexOf('/'));
            return slash >= 0 ? name.Substring(slash + 1) : name;
        }

        private static Module ModuleAt(List<Module> modules, ulong address)
        {
            foreach (Module module in modules)
            {
                if (address >= module.Base && address - module.Base < module.Size)
                {
                    return module;
                }
            }
            return null;
        }

        /// <summary>The memory the faulting thread's stack is in: its own descriptor, else the memory list entry holding rsp.</summary>
        private static Region FindStack(byte[] data, uint threadsRva, uint threadsSize, uint memoryRva, uint memorySize, uint threadId, ulong rsp)
        {
            if (threadsSize >= 4)
            {
                uint count = U32(data, threadsRva);
                if (count <= MaxThreads && (long)count * ThreadEntryBytes + 4 <= threadsSize)
                {
                    for (uint i = 0; i < count; i++)
                    {
                        long entry = threadsRva + 4 + (long)i * ThreadEntryBytes;
                        if (U32(data, entry) != threadId)
                        {
                            continue;
                        }
                        Region region = new Region();
                        region.Start = U64(data, entry + 24);
                        region.Size = U32(data, entry + 32);
                        region.Rva = U32(data, entry + 36);
                        if (region.Size > 0 && InRange(data, region.Rva, region.Size))
                        {
                            return region;
                        }
                    }
                }
            }
            if (memorySize >= 4 && rsp != 0)
            {
                uint count = U32(data, memoryRva);
                if (count <= MaxMemoryRanges && (long)count * MemoryEntryBytes + 4 <= memorySize)
                {
                    for (uint i = 0; i < count; i++)
                    {
                        long entry = memoryRva + 4 + (long)i * MemoryEntryBytes;
                        Region region = new Region();
                        region.Start = U64(data, entry);
                        region.Size = U32(data, entry + 8);
                        region.Rva = U32(data, entry + 12);
                        if (rsp >= region.Start && rsp - region.Start < region.Size && InRange(data, region.Rva, region.Size))
                        {
                            return region;
                        }
                    }
                }
            }
            return null;
        }

        /// <summary>Reads 8-byte values from rsp upward (the whole region when rsp is unknown) and names the modules they point into.</summary>
        private static void ScanStack(byte[] data, Region stack, ulong rsp, List<Module> modules, List<string> found)
        {
            long first = 0;
            if (rsp >= stack.Start && rsp - stack.Start < stack.Size)
            {
                first = (long)(rsp - stack.Start);
            }
            long end = Math.Min((long)stack.Size, first + MaxScanBytes);
            for (long at = first; at + 8 <= end && found.Count < MaxStackModules; at += 8)
            {
                Module module = ModuleAt(modules, U64(data, stack.Rva + at));
                if (module != null && !found.Contains(module.Name))
                {
                    found.Add(module.Name);
                }
            }
        }

        private static bool InRange(byte[] data, long offset, long length)
        {
            return offset >= 0 && length >= 0 && offset + length <= data.Length;
        }

        private static uint U32(byte[] data, long offset)
        {
            if (!InRange(data, offset, 4))
            {
                throw new InvalidDataException("a field is outside the file");
            }
            return BitConverter.ToUInt32(data, (int)offset);
        }

        private static ulong U64(byte[] data, long offset)
        {
            if (!InRange(data, offset, 8))
            {
                throw new InvalidDataException("a field is outside the file");
            }
            return BitConverter.ToUInt64(data, (int)offset);
        }

        private static string Quote(string text)
        {
            StringBuilder builder = new StringBuilder("\"");
            foreach (char ch in text)
            {
                if (ch == '"' || ch == '\\')
                {
                    builder.Append('\\').Append(ch);
                }
                else if (ch < ' ' || ch > '~')
                {
                    builder.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                }
                else
                {
                    builder.Append(ch);
                }
            }
            return builder.Append('"').ToString();
        }
    }
}
