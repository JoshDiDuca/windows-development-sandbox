// AgentSandboxStorage.exe: the contained-storage helper of windows-development-sandbox.
//   service --group <sid>        what Windows runs (the service AgentSandboxStorage, LocalSystem).
//   console --pipe <name> --group <sid> --log-folder <dir> [--mutex <name>] [--machine-config <file>|none]
//           [--profile <dir>] [--records <dir>] [--dry-run]
//                                the same server in a console, for tests and a live check: it runs with the rights of
//                                whoever starts it (so the test switches grant nothing) and stops when its input ends.
//   check <mount|dismount> <storageRoot> <set> <userSid> <maxGb>
//                                a dry run of the checks on one data set (no pipe, no disk is touched); prints the answer.
//   derive <request.json>        Settings.Derive on {machine, user, base, profile, env}; prints {ok, root, maxGb}.
//   parse                        Protocol.Parse on one line of input; prints {ok, verb, set}.
//   release-all [--records <dir>] [--dry-run]
//                                (administrators, when the helper is removed) dismounts every set the service mounted.
// Exit code 0 = ok, 1 = refused or failed, 2 = wrong use.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Web.Script.Serialization;

namespace AgentSandbox.StorageHelper
{
    public static class Program
    {
        private const int ExitOk = 0;
        private const int ExitFailed = 1;
        private const int ExitUsage = 2;

        public static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                return Usage();
            }
            try
            {
                switch (args[0])
                {
                    case "service":
                        return RunService(Options(args));
                    case "console":
                        return RunConsole(Options(args));
                    case "check":
                        return Check(args);
                    case "derive":
                        return Derive(args);
                    case "parse":
                        return Parse();
                    case "release-all":
                        return ReleaseAll(Options(args));
                    case "version":
                        Console.Out.WriteLine(Assembly.GetExecutingAssembly().GetName().Version.ToString());
                        return ExitOk;
                    default:
                        return Usage();
                }
            }
            catch (ArgumentException e)
            {
                Console.Error.WriteLine("Usage: " + e.Message);
                return ExitUsage;
            }
        }

        private static int Usage()
        {
            Console.Error.WriteLine("Usage: AgentSandboxStorage.exe service|console|check|derive|parse|version (see the source header)");
            return ExitUsage;
        }

        private static Dictionary<string, string> Options(string[] args)
        {
            Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--dry-run")
                {
                    options["--dry-run"] = "1";
                }
                else if (args[i].StartsWith("--", StringComparison.Ordinal) && i + 1 < args.Length)
                {
                    options[args[i]] = args[i + 1];
                    i++;
                }
                else
                {
                    throw new ArgumentException("unknown option " + args[i]);
                }
            }
            return options;
        }

        private static string Need(Dictionary<string, string> options, string name)
        {
            string value;
            if (!options.TryGetValue(name, out value) || value.Length == 0)
            {
                throw new ArgumentException(name + " is needed");
            }
            return value;
        }

        private static SecurityIdentifier GroupOf(Dictionary<string, string> options)
        {
            try
            {
                return new SecurityIdentifier(Need(options, "--group"));
            }
            catch (ArgumentException)
            {
                throw new ArgumentException("--group needs a SID");
            }
        }

        private static string MachineData()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AgentSandbox");
        }

        /// <summary>Loads the DLLs the service calls before it ever acts as a client (nothing is loaded while it does).</summary>
        private static void Warm()
        {
            Marshal.PrelinkAll(typeof(Win32.NativeMethods));
            foreach (Type type in typeof(Program).Assembly.GetTypes())
            {
                if (type.Name == "NativeMethods")
                {
                    Marshal.PrelinkAll(type);
                }
            }
            new JavaScriptSerializer().DeserializeObject("{\"a\":1}");
        }

        private static void PrepareProcess()
        {
            Warm();
            Privileges.Enable("SeManageVolumePrivilege", "SeRestorePrivilege", "SeBackupPrivilege", "SeImpersonatePrivilege");
        }

        private static int RunService(Dictionary<string, string> options)
        {
            SecurityIdentifier group = GroupOf(options);
            PrepareProcess();
            string data = MachineData();
            ServiceBase.Run(new StorageService(delegate()
            {
                ServerOptions o = new ServerOptions();
                o.PipeName = Server.DefaultPipe;
                o.MutexName = Server.DefaultMutex;
                o.Group = group;
                o.Log = Log.InFolder(Path.Combine(data, "logs"), true);
                o.Sources = new SettingsSources();
                o.Sources.MachineFile = Path.Combine(data, "config.json");
                o.Records = new MountRecords(Path.Combine(data, "storage-helper"));
                return new Server(o);
            }));
            return ExitOk;
        }

        private static int RunConsole(Dictionary<string, string> options)
        {
            PrepareProcess();
            ServerOptions o = new ServerOptions();
            o.PipeName = Need(options, "--pipe");
            string mutex;
            o.MutexName = options.TryGetValue("--mutex", out mutex) ? mutex : "Local\\AgentSandboxStorage-" + o.PipeName;
            o.Group = GroupOf(options);
            try
            {
                o.Log = Log.InFolder(Need(options, "--log-folder"), false);
            }
            catch (IOException e)
            {
                Console.Error.WriteLine(e.Message);
                return ExitFailed;
            }
            o.Sources = new SettingsSources();
            string machine;
            o.Sources.MachineFile = options.TryGetValue("--machine-config", out machine) ? (machine == "none" ? null : machine) : Path.Combine(MachineData(), "config.json");
            string profile;
            if (options.TryGetValue("--profile", out profile))
            {
                o.Sources.ProfileOverride = profile;
            }
            o.DryRun = options.ContainsKey("--dry-run");
            string records;
            if (options.TryGetValue("--records", out records))
            {
                o.Records = new MountRecords(records);
            }
            using (Server server = new Server(o))
            {
                try
                {
                    server.Start();
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e.Message);
                    return ExitFailed;
                }
                Console.Out.WriteLine("ready");
                Console.Out.Flush();
                Console.In.ReadToEnd();
            }
            return ExitOk;
        }

        private static int ReleaseAll(Dictionary<string, string> options)
        {
            PrepareProcess();
            string folder;
            if (!options.TryGetValue("--records", out folder))
            {
                folder = Path.Combine(MachineData(), "storage-helper");
            }
            if (!Directory.Exists(folder))
            {
                Console.Out.WriteLine("nothing recorded");
                return ExitOk;
            }
            MountRecords records = new MountRecords(folder);
            bool dry = options.ContainsKey("--dry-run");
            int failed = 0;
            using (System.Threading.Mutex mutex = new System.Threading.Mutex(false, Server.DefaultMutex))
            {
                bool held;
                try
                {
                    held = mutex.WaitOne(60000);
                }
                catch (System.Threading.AbandonedMutexException)
                {
                    held = true;
                }
                if (!held)
                {
                    Console.Error.WriteLine("Another mount or dismount is running. Try again in a minute.");
                    return ExitFailed;
                }
                try
                {
                    foreach (MountRecord record in records.Read())
                    {
                        Request request = Server.RecordRequest(record);
                        request.DryRun = dry;
                        Outcome outcome = Operations.Run(request);
                        Console.Out.WriteLine(record.Set + " (" + record.StorageRoot + "): " + (outcome.Ok ? "" : "refused: ") + outcome.Message);
                        if (outcome.Ok && !dry)
                        {
                            records.Remove(record);
                        }
                        if (!outcome.Ok)
                        {
                            failed++;
                        }
                    }
                }
                finally
                {
                    mutex.ReleaseMutex();
                }
            }
            return failed == 0 ? ExitOk : ExitFailed;
        }

        private static int Check(string[] args)
        {
            if (args.Length != 6)
            {
                throw new ArgumentException("check <mount|dismount> <storageRoot> <set> <userSid> <maxGb>");
            }
            long maxGb;
            if (!long.TryParse(args[5], out maxGb))
            {
                throw new ArgumentException("maxGb must be a number");
            }
            Request request = new Request();
            request.Verb = args[1];
            request.Set = args[3];
            request.User = new SecurityIdentifier(args[4]);
            request.Settings = new StorageSettings(args[2], maxGb);
            request.DryRun = true;
            Outcome outcome = Operations.Run(request);
            Console.Out.WriteLine(Protocol.Answer(outcome));
            return outcome.Ok ? ExitOk : ExitFailed;
        }

        private static int Derive(string[] args)
        {
            if (args.Length != 2)
            {
                throw new ArgumentException("derive <request.json>");
            }
            Dictionary<string, object> input = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(args[1], Encoding.UTF8)) as Dictionary<string, object>;
            if (input == null)
            {
                throw new ArgumentException("the request must be a JSON object");
            }
            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            object env;
            if (input.TryGetValue("env", out env) && env is Dictionary<string, object>)
            {
                foreach (KeyValuePair<string, object> pair in (Dictionary<string, object>)env)
                {
                    environment[pair.Key] = pair.Value as string ?? "";
                }
            }
            try
            {
                StorageSettings s = Settings.Derive(Text(input, "machine"), Text(input, "user"), Text(input, "base"), Text(input, "profile"), environment);
                Console.Out.WriteLine("{\"ok\":true,\"root\":" + Protocol.Quote(s.StorageRoot) + ",\"maxGb\":" + s.MaxGb + "}");
                return ExitOk;
            }
            catch (RefusedException e)
            {
                Console.Out.WriteLine("{\"ok\":false,\"message\":" + Protocol.Quote(e.Message) + "}");
                return ExitFailed;
            }
        }

        private static string Text(Dictionary<string, object> input, string key)
        {
            object value;
            return input.TryGetValue(key, out value) ? value as string : null;
        }

        private static int Parse()
        {
            string line = Console.In.ReadLine();
            try
            {
                string verb;
                string set;
                Protocol.Parse(line, out verb, out set);
                Console.Out.WriteLine("{\"ok\":true,\"verb\":" + Protocol.Quote(verb) + ",\"set\":" + Protocol.Quote(set) + "}");
                return ExitOk;
            }
            catch (RefusedException e)
            {
                Console.Out.WriteLine("{\"ok\":false,\"message\":" + Protocol.Quote(e.Message) + "}");
                return ExitFailed;
            }
        }
    }
}
