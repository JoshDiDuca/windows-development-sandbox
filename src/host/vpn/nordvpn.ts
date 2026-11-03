// Picks a NordVPN server at launch from NordVPN's public server API and fetches its OpenVPN profile. Done on this PC,
// not in the sandbox: the sandbox's firewall then needs no hole for the API or the download host, and what comes back
// is checked here (bounded size, strict shapes, shared/vpn/ovpn.ts) before the sandbox gets it. Nothing here needs
// the login: the profiles are public.
import { z } from 'zod';
import { fetchBounded, type Fetcher } from '../../shared/download/index.js';
import { fail } from '../../core/util/index.js';
import { MAX_OVPN_BYTES } from '../../shared/vpn/ovpn.js';

const API = 'https://api.nordvpn.com/v1';
const CONFIGS = 'https://downloads.nordcdn.com/configs/files';
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export { fetchBounded, type Fetcher };

const CountriesSchema = z
  .array(z.object({ id: z.number().int(), name: z.string().max(100), code: z.string().max(4) }))
  .max(400);
const ServersSchema = z
  .array(
    z.object({
      hostname: z.string().regex(/^[a-z0-9-]{2,40}\.nordvpn\.com$/),
      station: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/),
    }),
  )
  .max(50);

export interface NordServer {
  /** e.g. uk2201.nordvpn.com */
  readonly hostname: string;
  readonly ip: string;
}

/** Names people type that NordVPN spells differently. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  uk: 'gb',
  'united kingdom': 'gb',
  usa: 'us',
  america: 'us',
};

/** The country's id at NordVPN for what was typed (code or name, any case); fails listing nothing it cannot back up. */
export function findCountry(countries: z.output<typeof CountriesSchema>, typed: string): number {
  const want = typed.trim().toLowerCase();
  const alias = COUNTRY_ALIASES[want] ?? want;
  const found = countries.find((c) => c.code.toLowerCase() === alias || c.name.toLowerCase() === alias);
  if (!found)
    fail(
      'NordVPN has no country "' + typed + '".',
      'Use a name like Germany or a code like de (vpn.country in your settings), or leave it empty.',
    );
  return found.id;
}

/** The recommended server for the country (or anywhere) and protocol. */
export async function recommendedServer(
  protocol: 'udp' | 'tcp',
  country: string,
  fetchText: Fetcher = fetchBounded,
): Promise<NordServer> {
  const filters = ['filters[servers_technologies][identifier]=openvpn_' + protocol, 'limit=1'];
  if (country.trim()) {
    const countries = CountriesSchema.safeParse(
      JSON.parse(await fetchText(API + '/servers/countries', MAX_JSON_BYTES)),
    );
    if (!countries.success) fail("NordVPN's list of countries was not in the expected form.", 'Try again later.');
    filters.push('filters[country_id]=' + findCountry(countries.data, country));
  }
  const answer = ServersSchema.safeParse(
    JSON.parse(await fetchText(API + '/servers/recommendations?' + filters.join('&'), MAX_JSON_BYTES)),
  );
  if (!answer.success || answer.data.length === 0)
    fail(
      'NordVPN did not recommend a server' + (country.trim() ? ' in ' + country.trim() : '') + '.',
      'Try another country (vpn.country), or leave it empty.',
    );
  return { hostname: answer.data[0].hostname, ip: answer.data[0].station };
}

/** The server's OpenVPN profile (not yet checked: shared/vpn/ovpn.ts does that). */
export function nordProfile(
  server: NordServer,
  protocol: 'udp' | 'tcp',
  fetchText: Fetcher = fetchBounded,
): Promise<string> {
  return fetchText(
    CONFIGS + '/ovpn_' + protocol + '/servers/' + server.hostname + '.' + protocol + '.ovpn',
    MAX_OVPN_BYTES,
  );
}
