// The few Switchboard (Caprid control plane) calls aim needs, made with the room owner's API key.
// Only `aim new`, `aim invite` and `aim revoke` use it; joining needs no API key.
import { execFileSync, spawnSync } from 'node:child_process';

const API = (process.env.AIM_CAPRID_API || 'https://app.caprid.com').replace(/\/+$/, '');
const SERVICE = 'aim-caprid';
const ACCOUNT = 'api-key';

function keychainGet(service) {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    }
    if (process.platform === 'linux') {
      return execFileSync('secret-tool', ['lookup', 'service', service, 'account', ACCOUNT], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    }
  } catch {
    /* not stored */
  }
  return undefined;
}

/** CAPRID_API_KEY wins; then `aim login`'s keychain entry; then Aperture's (`aperture login`). */
export function apiKey() {
  return process.env.CAPRID_API_KEY || keychainGet(SERVICE) || keychainGet('aperture-caprid');
}

export function storeApiKey(key) {
  if (!/^[\x21-\x7e]+$/.test(key) || /["\\]/.test(key)) throw new Error('that does not look like an API key');
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${key}"\n` });
    if (r.status !== 0) throw new Error('could not store the key in the macOS keychain');
  } else if (process.platform === 'linux') {
    const r = spawnSync('secret-tool', ['store', '--label', 'aim Caprid API key', 'service', SERVICE, 'account', ACCOUNT], { input: key });
    if (r.status !== 0) throw new Error('could not store the key with secret-tool; export CAPRID_API_KEY instead');
  } else {
    throw new Error('no keychain on this platform; export CAPRID_API_KEY instead');
  }
}

async function call(key, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = String(json.error ?? json.message ?? `HTTP ${res.status}`).split(key).join('<key>');
    const err = new Error(`Switchboard ${method} ${path}: ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export function requireKey() {
  const key = apiKey();
  if (!key) {
    throw new Error(
      'creating rooms and invites needs a Caprid API key: run `aim login` (hidden prompt; key from app.caprid.com), or export CAPRID_API_KEY. Joining with an invite needs none.',
    );
  }
  return key;
}

/** Which Namespace to put rooms in: --ns, AIM_CAPRID_NAMESPACE, else the account's only one. */
export async function resolveNamespace(key, explicit) {
  const ns = explicit || process.env.AIM_CAPRID_NAMESPACE;
  if (ns) return ns;
  const acct = await call(key, 'GET', '/v1/account');
  const names = new Set(acct.account?.api_key?.namespaces ?? []);
  if (!names.size) {
    for (const org of acct.account?.organizations ?? []) {
      for (const n of await call(key, 'GET', `/v1/organizations/${org.id}/namespaces`)) names.add(n.name);
    }
  }
  if (names.size === 1) return [...names][0];
  if (!names.size) throw new Error('this API key reaches no Caprid Namespace');
  throw new Error(`pick a Namespace with --ns (one of: ${[...names].join(', ')})`);
}

const label = (room, name) => `aim-${room}--${name}`;

/**
 * A Signing key that can only sign tokens rooted at <ns>/aim/<room>, publishing only under u/<name>.
 * The relay enforces that scope, so an invite cannot speak as anyone else or reach any other room.
 */
export async function createMemberKey(key, ns, room, name) {
  const jwk = await call(key, 'POST', `/v1/namespaces/${encodeURIComponent(ns)}/keys`, {
    label: label(room, name),
    path: `aim/${room}`,
    publish: [`u/${name}`],
    subscribe: [''],
  });
  if (!jwk.k || !jwk.kid) throw new Error('Switchboard returned no key secret');
  return { kid: jwk.kid, k: jwk.k };
}

export async function deleteMemberKey(key, ns, room, name) {
  await call(key, 'DELETE', `/v1/namespaces/${encodeURIComponent(ns)}/keys/${encodeURIComponent(`${ns}_${label(room, name)}`)}`);
}

export async function listMemberKeys(key, ns, room) {
  const r = await call(key, 'GET', `/v1/namespaces/${encodeURIComponent(ns)}/keys`);
  const keys = Array.isArray(r) ? r : (r.keys ?? []);
  const prefix = `${ns}_aim-${room}--`;
  return keys.filter((k) => k.kid?.startsWith(prefix)).map((k) => k.kid.slice(prefix.length));
}

/** A repo room's key: covers the repo's room and every branch room below it, for any member name. */
export async function createRepoKey(key, ns, label, keyPath) {
  const jwk = await call(key, 'POST', `/v1/namespaces/${encodeURIComponent(ns)}/keys`, { label, path: keyPath, publish: [''], subscribe: [''] });
  if (!jwk.k || !jwk.kid) throw new Error('Switchboard returned no key secret');
  return { kid: jwk.kid, k: jwk.k };
}

export async function deleteKey(key, ns, kid) {
  await call(key, 'DELETE', `/v1/namespaces/${encodeURIComponent(ns)}/keys/${encodeURIComponent(kid)}`);
}

export async function listKids(key, ns, labelPrefix) {
  const r = await call(key, 'GET', `/v1/namespaces/${encodeURIComponent(ns)}/keys`);
  const keys = Array.isArray(r) ? r : (r.keys ?? []);
  return keys.map((k) => k.kid).filter((kid) => kid?.startsWith(`${ns}_${labelPrefix}`));
}
