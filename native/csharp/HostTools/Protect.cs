// HostTools protect / unprotect: Windows DPAPI for the current user, as native\scripts\protect-data.ps1 does it (same
// entropy, same format), without starting PowerShell. Standard input: base64 of the bytes; standard output: base64 of
// the result. Nothing goes on the command line or to disk.
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace AgentSandbox
{
    static class Protect
    {
        /// <summary>The fixed extra secret of protect-data.ps1: another program that calls DPAPI without it cannot open these.</summary>
        private const string Entropy = "agent-sandbox/secret-store/v1";

        public static int Run(bool protect)
        {
            try
            {
                string text;
                using (Stream input = Console.OpenStandardInput())
                using (StreamReader reader = new StreamReader(input, Encoding.ASCII))
                {
                    text = reader.ReadToEnd().Trim();
                }
                byte[] data = Convert.FromBase64String(text);
                byte[] entropy = Encoding.UTF8.GetBytes(Entropy);
                byte[] result = protect
                    ? ProtectedData.Protect(data, entropy, DataProtectionScope.CurrentUser)
                    : ProtectedData.Unprotect(data, entropy, DataProtectionScope.CurrentUser);
                Console.Out.Write(Convert.ToBase64String(result));
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }
    }
}
