// What the service has mounted, so nothing is left behind: one line per mount (user SID, storage folder, data set) in
// %ProgramData%\AgentSandbox\storage-helper\mounts.txt, a folder only administrators may change. When the service starts
// it takes off mount points whose disk is gone (the PC restarted while mounted; the Windows permission prompt's script
// would otherwise find a stale mount point), and uninstalling runs `release-all`, which dismounts every recorded set with
// the usual checks. The file is only ever read and written by this service as SYSTEM.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;
using System.Text;

namespace AgentSandbox.StorageHelper
{
    public sealed class MountRecord
    {
        public MountRecord(string sid, string storageRoot, string set)
        {
            Sid = sid;
            StorageRoot = storageRoot;
            Set = set;
        }

        public string Sid { get; private set; }
        public string StorageRoot { get; private set; }
        public string Set { get; private set; }

        public string Key
        {
            get { return (Sid + "\t" + StorageRoot + "\t" + Set).ToUpperInvariant(); }
        }
    }

    public sealed class MountRecords
    {
        private const int MaxRecords = 1000;
        private readonly object gate = new object();
        private readonly string file;

        public MountRecords(string folder)
        {
            // Checked like the log folder: administrators only, no link on the way.
            Log.InFolder(folder, true);
            file = Path.Combine(folder, "mounts.txt");
        }

        public List<MountRecord> Read()
        {
            lock (gate)
            {
                List<MountRecord> records = new List<MountRecord>();
                if (!File.Exists(file))
                {
                    return records;
                }
                foreach (string line in File.ReadAllLines(file, Encoding.UTF8))
                {
                    string[] parts = line.Split('\t');
                    if (parts.Length != 3 || !Rules.IsSetName(parts[2]) || !Rules.IsPlainAbsolute(parts[1]))
                    {
                        continue;
                    }
                    try
                    {
                        new SecurityIdentifier(parts[0]);
                    }
                    catch (ArgumentException)
                    {
                        continue;
                    }
                    records.Add(new MountRecord(parts[0], parts[1], parts[2]));
                    if (records.Count >= MaxRecords)
                    {
                        break;
                    }
                }
                return records;
            }
        }

        public void Add(MountRecord record)
        {
            lock (gate)
            {
                List<MountRecord> records = Read();
                foreach (MountRecord r in records)
                {
                    if (r.Key == record.Key)
                    {
                        return;
                    }
                }
                records.Add(record);
                Save(records);
            }
        }

        public void Remove(MountRecord record)
        {
            lock (gate)
            {
                List<MountRecord> kept = new List<MountRecord>();
                foreach (MountRecord r in Read())
                {
                    if (r.Key != record.Key)
                    {
                        kept.Add(r);
                    }
                }
                Save(kept);
            }
        }

        private void Save(List<MountRecord> records)
        {
            StringBuilder sb = new StringBuilder();
            int count = 0;
            foreach (MountRecord r in records)
            {
                if (count++ >= MaxRecords)
                {
                    break;
                }
                sb.Append(r.Sid).Append('\t').Append(r.StorageRoot).Append('\t').Append(r.Set).Append("\r\n");
            }
            string temp = file + ".tmp";
            File.WriteAllText(temp, sb.ToString(), new UTF8Encoding(false));
            if (File.Exists(file))
            {
                File.Replace(temp, file, null);
            }
            else
            {
                File.Move(temp, file);
            }
        }
    }
}
