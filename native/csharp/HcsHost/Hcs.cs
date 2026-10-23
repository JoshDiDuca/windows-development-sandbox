// Calls into computecore.dll (Host Compute Service) and computestorage.dll (HcsGrantVmAccess). Signatures are from
// the Microsoft HCS API reference (learn.microsoft.com/virtualization/api/hcs/reference/*), checked there for the
// operation and compute-system functions; HcsGrantVmAccess is from the computestorage.h header (not re-checked).
// Nothing here has run against a real HCS: the PC this was written on had no Hyper-V.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentSandbox.HcsHost
{
    /// <summary>What an HCS call answered: the HRESULT and the JSON document (result or error) that came with it.</summary>
    public sealed class HcsReply
    {
        public int HResult;
        public string Json = "";

        public bool Ok
        {
            get { return HResult == 0; }
        }

        public string Message()
        {
            if (HResult == 0)
            {
                return "ok";
            }
            string known = HcsErrorText((uint)HResult);
            if (known != null)
            {
                return known;
            }
            Exception ex = Marshal.GetExceptionForHR(HResult);
            return ex != null ? ex.Message : "error 0x" + HResult.ToString("X8");
        }

        /// <summary>The HCS-specific codes (learn.microsoft.com/virtualization/api/hcs/reference/hcshresult), or null.</summary>
        private static string HcsErrorText(uint hr)
        {
            switch (hr)
            {
                case 0x80370102u:
                    return "a required Windows feature is not installed (HCS_E_HYPERV_NOT_INSTALLED)";
                case 0x8037010Du:
                    return "the compute system document is invalid (HCS_E_INVALID_JSON)";
                case 0x8037010Eu:
                    return "no compute system has that id (HCS_E_SYSTEM_NOT_FOUND)";
                case 0x8037010Fu:
                    return "a compute system with that id already exists (HCS_E_SYSTEM_ALREADY_EXISTS)";
                case 0x80370110u:
                    return "the compute system is not running (HCS_E_SYSTEM_ALREADY_STOPPED)";
                case 0x80370114u:
                    return "a required Windows feature is not installed (HCS_E_SERVICE_NOT_AVAILABLE)";
                case 0x80370118u:
                    return "the operation did not complete in time (HCS_E_OPERATION_TIMEOUT)";
                case 0x8037011Bu:
                    return "only Administrators or Hyper-V Administrators may do this (HCS_E_ACCESS_DENIED, see https://aka.ms/hcsadmin)";
                default:
                    return null;
            }
        }
    }

    public static class Hcs
    {
        /// <summary>HcsOpenComputeSystem documents no narrower right than GENERIC_ALL for modify.</summary>
        private const uint GenericAll = 0x10000000;
        private const uint LoadLibrarySearchSystem32 = 0x00000800;
        private const uint QueryMs = 15000;
        private const uint ChangeMs = 180000;

        private delegate int Begin(IntPtr operation);

        private delegate int BeginOn(IntPtr system, IntPtr operation);

        private static class NativeMethods
        {
            [DllImport("computecore.dll", ExactSpelling = true, SetLastError = true)]
            public static extern IntPtr HcsCreateOperation(IntPtr context, IntPtr callback);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern void HcsCloseOperation(IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern int HcsWaitForOperationResult(IntPtr operation, uint timeoutMs, out IntPtr resultDocument);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsEnumerateComputeSystems(string query, IntPtr operation);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsCreateComputeSystem(string id, string configuration, IntPtr operation, IntPtr securityDescriptor, out IntPtr computeSystem);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsOpenComputeSystem(string id, uint requestedAccess, out IntPtr computeSystem);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsStartComputeSystem(IntPtr computeSystem, IntPtr operation, string options);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsTerminateComputeSystem(IntPtr computeSystem, IntPtr operation, string options);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsGetComputeSystemProperties(IntPtr computeSystem, IntPtr operation, string propertyQuery);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsModifyComputeSystem(IntPtr computeSystem, IntPtr operation, string configuration, IntPtr identity);

            [DllImport("computecore.dll", ExactSpelling = true)]
            public static extern void HcsCloseComputeSystem(IntPtr computeSystem);

            [DllImport("computecore.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsGetServiceProperties(string propertyQuery, out IntPtr result);

            [DllImport("computestorage.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
            public static extern int HcsGrantVmAccess(string vmId, string filePath);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr LocalFree(IntPtr mem);

            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool FreeLibrary(IntPtr module);
        }

        /// <summary>A LocalFree-able wide string from HCS, as text (empty when null).</summary>
        private static string TakeString(IntPtr p)
        {
            if (p == IntPtr.Zero)
            {
                return "";
            }
            try
            {
                return Marshal.PtrToStringUni(p);
            }
            finally
            {
                NativeMethods.LocalFree(p);
            }
        }

        /// <summary>Whether a DLL (computecore.dll) can be loaded at all on this PC (from System32 only).</summary>
        public static bool CanLoad(string dll)
        {
            IntPtr module = NativeMethods.LoadLibraryEx(dll, IntPtr.Zero, LoadLibrarySearchSystem32);
            if (module == IntPtr.Zero)
            {
                return false;
            }
            NativeMethods.FreeLibrary(module);
            return true;
        }

        public static HcsReply ServiceProperties(string queryJson)
        {
            HcsReply reply = new HcsReply();
            IntPtr result = IntPtr.Zero;
            reply.HResult = NativeMethods.HcsGetServiceProperties(queryJson, out result);
            reply.Json = TakeString(result);
            return reply;
        }

        /// <summary>Starts an operation with `begin`, waits for it and returns its result document.</summary>
        private static HcsReply Run(Begin begin, uint waitMs)
        {
            HcsReply reply = new HcsReply();
            IntPtr operation = NativeMethods.HcsCreateOperation(IntPtr.Zero, IntPtr.Zero);
            if (operation == IntPtr.Zero)
            {
                reply.HResult = Marshal.GetHRForLastWin32Error();
                return reply;
            }
            try
            {
                int hr = begin(operation);
                if (hr != 0)
                {
                    reply.HResult = hr;
                    return reply;
                }
                IntPtr doc = IntPtr.Zero;
                reply.HResult = NativeMethods.HcsWaitForOperationResult(operation, waitMs, out doc);
                reply.Json = TakeString(doc);
                return reply;
            }
            finally
            {
                NativeMethods.HcsCloseOperation(operation);
            }
        }

        public static HcsReply Enumerate(string queryJson)
        {
            return Run(delegate(IntPtr op) { return NativeMethods.HcsEnumerateComputeSystems(queryJson, op); }, QueryMs);
        }

        /// <summary>Creates a compute system from a document. The handle is closed again: the system stays.</summary>
        public static HcsReply Create(string id, string document)
        {
            IntPtr system = IntPtr.Zero;
            try
            {
                return Run(
                    delegate(IntPtr op) { return NativeMethods.HcsCreateComputeSystem(id, document, op, IntPtr.Zero, out system); },
                    ChangeMs);
            }
            finally
            {
                if (system != IntPtr.Zero)
                {
                    NativeMethods.HcsCloseComputeSystem(system);
                }
            }
        }

        private static HcsReply WithSystem(string id, uint waitMs, BeginOn call)
        {
            IntPtr system = IntPtr.Zero;
            int hr = NativeMethods.HcsOpenComputeSystem(id, GenericAll, out system);
            if (hr != 0)
            {
                HcsReply failed = new HcsReply();
                failed.HResult = hr;
                return failed;
            }
            try
            {
                return Run(delegate(IntPtr op) { return call(system, op); }, waitMs);
            }
            finally
            {
                NativeMethods.HcsCloseComputeSystem(system);
            }
        }

        public static HcsReply Start(string id)
        {
            return WithSystem(id, ChangeMs, delegate(IntPtr system, IntPtr op) { return NativeMethods.HcsStartComputeSystem(system, op, null); });
        }

        public static HcsReply Terminate(string id)
        {
            return WithSystem(id, ChangeMs, delegate(IntPtr system, IntPtr op) { return NativeMethods.HcsTerminateComputeSystem(system, op, null); });
        }

        public static HcsReply Properties(string id, string queryJson)
        {
            return WithSystem(id, QueryMs, delegate(IntPtr system, IntPtr op) { return NativeMethods.HcsGetComputeSystemProperties(system, op, queryJson); });
        }

        /// <summary>Applies one ModifySettingRequest to a running system (HcsModifyComputeSystem, no identity token).</summary>
        public static HcsReply Modify(string id, string modifySettingRequest)
        {
            return WithSystem(id, ChangeMs, delegate(IntPtr system, IntPtr op) { return NativeMethods.HcsModifyComputeSystem(system, op, modifySettingRequest, IntPtr.Zero); });
        }

        /// <summary>Opens a compute system and keeps the handle (Close it): checks and changes then use the same system.</summary>
        public static int Open(string id, out IntPtr system)
        {
            return NativeMethods.HcsOpenComputeSystem(id, GenericAll, out system);
        }

        public static void Close(IntPtr system)
        {
            if (system != IntPtr.Zero)
            {
                NativeMethods.HcsCloseComputeSystem(system);
            }
        }

        /// <summary>The properties of an opened system (Id, SystemType, Owner, State, ...).</summary>
        public static HcsReply PropertiesOf(IntPtr system)
        {
            return Run(delegate(IntPtr op) { return NativeMethods.HcsGetComputeSystemProperties(system, op, "{\"PropertyTypes\":[]}"); }, QueryMs);
        }

        /// <summary>One ModifySettingRequest on an opened system, waiting at most `waitMs`.</summary>
        public static HcsReply ModifyOn(IntPtr system, string modifySettingRequest, uint waitMs)
        {
            return Run(delegate(IntPtr op) { return NativeMethods.HcsModifyComputeSystem(system, op, modifySettingRequest, IntPtr.Zero); }, waitMs);
        }

        /// <summary>Lets the virtual machine `vmId` open the file (its disk). The file must exist.</summary>
        public static HcsReply GrantVmAccess(string vmId, string filePath)
        {
            HcsReply reply = new HcsReply();
            reply.HResult = NativeMethods.HcsGrantVmAccess(vmId, filePath);
            return reply;
        }
    }
}
