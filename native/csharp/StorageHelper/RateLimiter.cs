// How often the service answers: a few calls a minute per user and a cap for everyone together, so no client can keep
// it (and the disks) busy. A refused call is logged only once per window for each user, so the log cannot be flooded.
using System;
using System.Collections.Generic;

namespace AgentSandbox.StorageHelper
{
    public sealed class RateLimiter
    {
        private readonly object gate = new object();
        private readonly int perKey;
        private readonly int total;
        private readonly TimeSpan window;
        private readonly Dictionary<string, Queue<DateTime>> calls = new Dictionary<string, Queue<DateTime>>(StringComparer.OrdinalIgnoreCase);
        private readonly Queue<DateTime> all = new Queue<DateTime>();
        private readonly Dictionary<string, DateTime> lastRefusalLogged = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        public RateLimiter(int perKey, int total, TimeSpan window)
        {
            this.perKey = perKey;
            this.total = total;
            this.window = window;
        }

        /// <summary>True when this call may run (and counts it).</summary>
        public bool TryTake(string key, DateTime now)
        {
            lock (gate)
            {
                Trim(all, now);
                Queue<DateTime> mine;
                if (!calls.TryGetValue(key, out mine))
                {
                    mine = new Queue<DateTime>();
                    calls[key] = mine;
                }
                Trim(mine, now);
                DropIdleKeys(now);
                if (mine.Count >= perKey || all.Count >= total)
                {
                    return false;
                }
                mine.Enqueue(now);
                all.Enqueue(now);
                return true;
            }
        }

        /// <summary>True for the first refusal of this key in a window (that one is logged, the rest are not).</summary>
        public bool ShouldLogRefusal(string key, DateTime now)
        {
            lock (gate)
            {
                DateTime last;
                if (lastRefusalLogged.TryGetValue(key, out last) && now - last < window)
                {
                    return false;
                }
                if (lastRefusalLogged.Count > 1000)
                {
                    lastRefusalLogged.Clear();
                }
                lastRefusalLogged[key] = now;
                return true;
            }
        }

        private void Trim(Queue<DateTime> queue, DateTime now)
        {
            while (queue.Count > 0 && now - queue.Peek() >= window)
            {
                queue.Dequeue();
            }
        }

        private void DropIdleKeys(DateTime now)
        {
            if (calls.Count < 1000)
            {
                return;
            }
            List<string> idle = new List<string>();
            foreach (KeyValuePair<string, Queue<DateTime>> pair in calls)
            {
                Trim(pair.Value, now);
                if (pair.Value.Count == 0)
                {
                    idle.Add(pair.Key);
                }
            }
            foreach (string key in idle)
            {
                calls.Remove(key);
            }
        }
    }
}
