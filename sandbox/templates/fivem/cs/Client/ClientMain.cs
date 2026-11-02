using System;
using System.Collections.Generic;
using CitizenFX.Core;
using static CitizenFX.Core.Native.API;

namespace {{namespace}}.Client
{
    /// <summary>{{name}}, client side: the /{{name}} command asks the server to say hello.</summary>
    public class ClientMain : BaseScript
    {
        public ClientMain()
        {
            RegisterCommand("{{name}}", new Action<int, List<object>, string>((source, args, raw) =>
            {
                TriggerServerEvent("{{name}}:hello");
            }), false);
            EventHandlers["{{name}}:reply"] += new Action<string>(message => Debug.WriteLine(message));
        }
    }
}
