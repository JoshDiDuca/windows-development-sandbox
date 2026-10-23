// The Windows service AgentSandboxStorage (LocalSystem, automatic start, installed by scripts\install.ps1 through
// native\scripts\set-storage-helper.ps1): starts the pipe server when Windows starts the service, stops it on stop.
using System;
using System.ServiceProcess;

namespace AgentSandbox.StorageHelper
{
    public sealed class StorageService : ServiceBase
    {
        public const string Name = "AgentSandboxStorage";
        private readonly Func<Server> create;
        private Server server;

        public StorageService(Func<Server> create)
        {
            this.create = create;
            ServiceName = Name;
            CanStop = true;
            CanShutdown = true;
            CanPauseAndContinue = false;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            server = create();
            try
            {
                server.Start();
            }
            catch
            {
                server.Dispose();
                server = null;
                throw;
            }
        }

        protected override void OnStop()
        {
            if (server != null)
            {
                server.Dispose();
                server = null;
            }
        }

        protected override void OnShutdown()
        {
            OnStop();
        }
    }
}
