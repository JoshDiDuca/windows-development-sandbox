// The Visual Studio Setup Configuration API as UnrealBuildTool calls it (MicrosoftPlatformSDK: SetupConfiguration,
// ISetupConfiguration2.EnumAllInstances, ISetupInstance2): every instance with its state, version, product, path and
// packages. Loaded by scripts\get-vs-setup.ps1 (Add-Type), which adds the file checks and writes the JSON. C# 5.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;

namespace AgentSandbox
{
    [ComImport]
    [Guid("42843719-DB4C-46C2-8E7C-64F1816EFD5B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISetupConfiguration
    {
        IEnumSetupInstances EnumInstances();
        ISetupInstance GetInstanceForCurrentProcess();
        ISetupInstance GetInstanceForPath([In, MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [Guid("26AAB78C-4A60-49D6-AF3B-3C35BC93365D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISetupConfiguration2 : ISetupConfiguration
    {
        new IEnumSetupInstances EnumInstances();
        new ISetupInstance GetInstanceForCurrentProcess();
        new ISetupInstance GetInstanceForPath([In, MarshalAs(UnmanagedType.LPWStr)] string path);
        IEnumSetupInstances EnumAllInstances();
    }

    [ComImport]
    [Guid("6380BCFF-41D3-4B2E-8B2E-BF8A6810C848")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IEnumSetupInstances
    {
        void Next(
            [In, MarshalAs(UnmanagedType.U4)] int celt,
            [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.Interface, SizeParamIndex = 0)]
            ISetupInstance[] rgelt,
            [Out, MarshalAs(UnmanagedType.U4)] out int pceltFetched);
        void Skip([In, MarshalAs(UnmanagedType.U4)] int celt);
        void Reset();
        IEnumSetupInstances Clone();
    }

    [ComImport]
    [Guid("B41463C3-8866-43B5-BC33-2B0676F7F42E")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISetupInstance
    {
        [return: MarshalAs(UnmanagedType.BStr)] string GetInstanceId();
        [return: MarshalAs(UnmanagedType.Struct)] FILETIME GetInstallDate();
        [return: MarshalAs(UnmanagedType.BStr)] string GetInstallationName();
        [return: MarshalAs(UnmanagedType.BStr)] string GetInstallationPath();
        [return: MarshalAs(UnmanagedType.BStr)] string GetInstallationVersion();
        [return: MarshalAs(UnmanagedType.BStr)] string GetDisplayName([In, MarshalAs(UnmanagedType.U4)] int lcid);
        [return: MarshalAs(UnmanagedType.BStr)] string GetDescription([In, MarshalAs(UnmanagedType.U4)] int lcid);
        [return: MarshalAs(UnmanagedType.BStr)] string ResolvePath([In, MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [Guid("89143C9A-05AF-49B0-B717-72E218A2185C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISetupInstance2 : ISetupInstance
    {
        [return: MarshalAs(UnmanagedType.BStr)] new string GetInstanceId();
        [return: MarshalAs(UnmanagedType.Struct)] new FILETIME GetInstallDate();
        [return: MarshalAs(UnmanagedType.BStr)] new string GetInstallationName();
        [return: MarshalAs(UnmanagedType.BStr)] new string GetInstallationPath();
        [return: MarshalAs(UnmanagedType.BStr)] new string GetInstallationVersion();
        [return: MarshalAs(UnmanagedType.BStr)] new string GetDisplayName([In, MarshalAs(UnmanagedType.U4)] int lcid);
        [return: MarshalAs(UnmanagedType.BStr)] new string GetDescription([In, MarshalAs(UnmanagedType.U4)] int lcid);
        [return: MarshalAs(UnmanagedType.BStr)] new string ResolvePath([In, MarshalAs(UnmanagedType.LPWStr)] string path);
        [return: MarshalAs(UnmanagedType.U4)] uint GetState();
        [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_UNKNOWN)]
        ISetupPackageReference[] GetPackages();
        ISetupPackageReference GetProduct();
        [return: MarshalAs(UnmanagedType.BStr)] string GetProductPath();
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetErrors();
        [return: MarshalAs(UnmanagedType.VariantBool)] bool IsLaunchable();
        [return: MarshalAs(UnmanagedType.VariantBool)] bool IsComplete();
    }

    [ComImport]
    [Guid("DA8D8A16-B2B6-4487-A2F1-594CCCCD6BF5")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISetupPackageReference
    {
        [return: MarshalAs(UnmanagedType.BStr)] string GetId();
        [return: MarshalAs(UnmanagedType.BStr)] string GetVersion();
        [return: MarshalAs(UnmanagedType.BStr)] string GetChip();
        [return: MarshalAs(UnmanagedType.BStr)] string GetLanguage();
        [return: MarshalAs(UnmanagedType.BStr)] string GetBranch();
        [return: MarshalAs(UnmanagedType.BStr)] string GetType();
        [return: MarshalAs(UnmanagedType.BStr)] string GetUniqueId();
        [return: MarshalAs(UnmanagedType.VariantBool)] bool GetIsExtension();
    }

    [ComImport]
    [Guid("177F0C4A-1CD3-4DE7-A32C-71DBBB9FA36D")]
    [ClassInterface(ClassInterfaceType.None)]
    public class SetupConfiguration
    {
    }

    /// <summary>One instance as the Setup API reports it.</summary>
    public class SetupInstanceInfo
    {
        public string InstanceId;
        public string InstallationPath;
        public string InstallationVersion;
        public string ProductId;
        public uint State;
        public bool IsComplete;
        public bool IsLaunchable;
        public string[] Packages;
    }

    public static class VsSetup
    {
        /// <summary>InstanceState.Local: the instance's files are on this machine (the only ones UnrealBuildTool uses).</summary>
        public const uint StateLocal = 1;

        /// <summary>Every instance EnumAllInstances lists (complete or not), as UnrealBuildTool enumerates them.</summary>
        public static SetupInstanceInfo[] AllInstances()
        {
            List<SetupInstanceInfo> found = new List<SetupInstanceInfo>();
            ISetupConfiguration2 setup = (ISetupConfiguration2)new SetupConfiguration();
            IEnumSetupInstances instances = setup.EnumAllInstances();
            ISetupInstance[] one = new ISetupInstance[1];
            while (true)
            {
                int fetched;
                instances.Next(1, one, out fetched);
                if (fetched == 0)
                {
                    break;
                }
                ISetupInstance2 instance = (ISetupInstance2)one[0];
                SetupInstanceInfo info = new SetupInstanceInfo();
                info.InstanceId = instance.GetInstanceId();
                info.InstallationPath = instance.GetInstallationPath();
                info.InstallationVersion = instance.GetInstallationVersion();
                info.State = instance.GetState();
                ISetupPackageReference product = instance.GetProduct();
                info.ProductId = product == null ? "" : product.GetId();
                info.IsComplete = instance.IsComplete();
                info.IsLaunchable = instance.IsLaunchable();
                ISetupPackageReference[] packages = instance.GetPackages();
                List<string> ids = new List<string>();
                if (packages != null)
                {
                    foreach (ISetupPackageReference package in packages)
                    {
                        ids.Add(package.GetId());
                    }
                }
                info.Packages = ids.ToArray();
                found.Add(info);
            }
            return found.ToArray();
        }
    }
}
