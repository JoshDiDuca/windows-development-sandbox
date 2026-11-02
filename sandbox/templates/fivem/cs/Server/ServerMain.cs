using System;
using CitizenFX.Core;

namespace {{namespace}}.Server
{
    /// <summary>{{name}}, server side: answers the client's hello.</summary>
    public class ServerMain : BaseScript
    {
        public ServerMain()
        {
            EventHandlers["{{name}}:hello"] += new Action<Player>(OnHello);
        }

        private void OnHello([FromSource] Player player)
        {
            Debug.WriteLine(player.Name + " said hello");
            player.TriggerEvent("{{name}}:reply", "Hello from the server");
        }
    }
}
