/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 分层网络策略。
 *
 * 应用内浏览器和普通浏览器有一个本质区别：它跑在用户的机器上，却由 Agent 驱动导航。
 * 于是 `http://127.0.0.1:8080` 这类地址不再是「用户自己敲的本地服务」，而可能是远端页面
 * 通过一次跳转让 Agent 替它访问的内网资源 —— 经典的 SSRF/DNS rebinding 形态。
 *
 * 所以这里不做「允许 / 不允许」的二元判断，而是把目标分成若干层，每层有各自的准入条件：
 *
 * - `public`     公网，默认放行
 * - `loopback`   本机回环。只有在预览本地服务这一个用途下、且 origin 在白名单里才放行
 * - `private`    RFC1918 / ULA 内网。同上，但更严：跳转过去一律拒绝
 * - `linkLocal`  链路本地（169.254/16、fe80::/10），一律拒绝
 * - `metadata`   云厂商实例元数据（169.254.169.254 等），无条件拒绝，白名单也不放行
 *
 * 关键点是「每一跳都要重算」：白名单是按 origin 授的，而重定向可以把一个已授权的公网
 * origin 换成内网地址；DNS 也可以在两次解析之间把同一个域名指到内网。因此除了 URL 级
 * 判定之外，还提供 redirect 复核与「已解析 IP」复核两个入口，缺一不可。
 *
 * Layered network policy. The in-app browser differs from an ordinary browser in one essential
 * way: it runs on the user's machine but is driven by an agent. `http://127.0.0.1:8080` is
 * therefore no longer "a local service the user typed"; it may be an intranet resource a remote
 * page steered the agent into fetching on its behalf — the classic SSRF / DNS-rebinding shape.
 *
 * So this is not an allow/deny binary. Targets are sorted into layers, each with its own
 * admission rule: `public` is allowed by default; `loopback` and `private` only for the local
 * preview use case and only for allowlisted origins (and never as the destination of a
 * redirect); `linkLocal` is always refused; cloud instance `metadata` is refused
 * unconditionally, allowlist or not.
 *
 * The crucial part is that every hop is re-evaluated. The allowlist is granted per origin, but
 * a redirect can swap an allowlisted public origin for an intranet address, and DNS can point
 * one hostname at an intranet address between two lookups. Hence the separate redirect and
 * resolved-address entry points alongside the URL-level check — none of the three is redundant.
 */

/** 目标所属的网络层 / The network layer a target belongs to. */
export type BrowserNetworkZone = 'public' | 'loopback' | 'private' | 'linkLocal' | 'metadata' | 'invalid';

export type BrowserNetworkVerdict =
  | { allowed: true; zone: BrowserNetworkZone }
  | { allowed: false; zone: BrowserNetworkZone; reason: string };

export type BrowserNetworkOptions = {
  /**
   * 明确允许访问的内网 origin。由用户在预览本地服务时授予，不是 Agent 能自己填的。
   * Origins explicitly allowed to reach loopback or private addresses. Granted by the user for
   * local preview; never something the agent can add for itself.
   */
  allowedPrivateOrigins?: ReadonlySet<string>;
};

/** 云厂商实例元数据服务：拿到它等于拿到云凭证 / Cloud instance metadata — reaching it means credentials. */
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data']);
const METADATA_IPV4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200']);

/** 本身就代表内网的域名后缀 / Suffixes that denote an intranet by construction. */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.intranet', '.home.arpa', '.lan'];

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const classifyIpv4 = (octets: readonly number[], literal: string): BrowserNetworkZone => {
  if (octets.some((octet) => octet > 255)) return 'invalid';
  if (METADATA_IPV4.has(literal)) return 'metadata';
  const [first, second] = octets;
  // 0.0.0.0/8 在多数系统上就是「本机」，和 127/8 一样必须当回环处理。
  // 0.0.0.0/8 means "this host" on most stacks and has to be treated exactly like 127/8.
  if (first === 0 || first === 127) return 'loopback';
  if (first === 169 && second === 254) return 'linkLocal';
  if (first === 10) return 'private';
  if (first === 192 && second === 168) return 'private';
  if (first === 172 && second >= 16 && second <= 31) return 'private';
  // 100.64/10 是运营商级 NAT，同样不是公网可路由地址。
  // 100.64/10 is carrier-grade NAT, likewise not publicly routable.
  if (first === 100 && second >= 64 && second <= 127) return 'private';
  return 'public';
};

const classifyIpv6 = (literal: string): BrowserNetworkZone => {
  const normalized = literal.toLowerCase();
  if (normalized === '::' || normalized === '::1') return 'loopback';
  // `::ffff:127.0.0.1` 是 IPv4-mapped 写法，按内嵌的 v4 地址分类，否则就是一个绕过口。
  // `::ffff:127.0.0.1` is an IPv4-mapped address; classifying by the embedded v4 address is
  // what stops the notation from being a bypass.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped) return classifyHostname(mapped[1]);
  if (/^fe[89ab]/.test(normalized)) return 'linkLocal';
  if (/^f[cd]/.test(normalized)) return 'private';
  return 'public';
};

/**
 * 主机名（或 IP 字面量）属于哪一层。
 *
 * 只看名字，不做 DNS 解析：解析是异步的、可变的，而且解析结果本身要用
 * {@link evaluateResolvedAddress} 单独复核。
 *
 * The layer a hostname or IP literal belongs to, by name alone — no DNS resolution, which is
 * asynchronous, mutable, and separately re-checked by {@link evaluateResolvedAddress}.
 */
export const classifyHostname = (hostname: string): BrowserNetworkZone => {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return 'invalid';
  if (METADATA_HOSTNAMES.has(normalized)) return 'metadata';

  // URL 里的 IPv6 带方括号，去掉之后才是地址本身；带方括号的一定是 IPv6。
  // A URL wraps IPv6 in brackets; stripping them yields the address, and their presence is
  // itself the signal that this is IPv6.
  if (normalized.startsWith('[') && normalized.endsWith(']')) return classifyIpv6(normalized.slice(1, -1));
  if (normalized.includes(':')) return classifyIpv6(normalized);

  const ipv4 = IPV4_PATTERN.exec(normalized);
  if (ipv4) return classifyIpv4(ipv4.slice(1, 5).map(Number), normalized);

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return 'loopback';
  if (PRIVATE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'private';
  return 'public';
};

/** 某一层被拒绝时给用户的一句话 / The one-line reason given when a zone is refused. */
export const describeNetworkZone = (zone: BrowserNetworkZone): string => {
  switch (zone) {
    case 'metadata':
      return 'Cloud instance metadata endpoints are never reachable from the in-app browser.';
    case 'linkLocal':
      return 'Link-local addresses are not reachable from the in-app browser.';
    case 'loopback':
      return 'Local addresses are only reachable for an origin the user allowed for preview.';
    case 'private':
      return 'Private network addresses are only reachable for an origin the user allowed for preview.';
    case 'invalid':
      return 'The URL is invalid.';
    default:
      return 'Navigation is not allowed.';
  }
};

/**
 * 单个 URL 的准入判定。
 *
 * `about:blank` 特例放行：它是新建 tab 的初始地址，拦掉会让空白 tab 打不开。
 * 其余非 http(s) 协议一律拒绝 —— `file:` 能读本地文件，`javascript:` 能在当前页执行脚本，
 * 两者都不该由一次导航带进来。
 *
 * Admission check for a single URL. `about:blank` is allowed through as a special case — it is
 * the initial address of a new tab and refusing it would break opening one. Every other
 * non-http(s) scheme is refused: `file:` reads local files and `javascript:` executes in the
 * current page, and neither belongs in a navigation.
 */
export const evaluateNetworkTarget = (rawUrl: string, options: BrowserNetworkOptions = {}): BrowserNetworkVerdict => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, zone: 'invalid', reason: 'The URL is invalid.' };
  }
  if (url.href === 'about:blank') return { allowed: true, zone: 'public' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, zone: 'invalid', reason: `Navigation scheme ${url.protocol} is not allowed.` };
  }

  const zone = classifyHostname(url.hostname);
  if (zone === 'public') return { allowed: true, zone };
  if (zone === 'metadata' || zone === 'linkLocal' || zone === 'invalid') {
    return { allowed: false, zone, reason: describeNetworkZone(zone) };
  }
  // loopback 与 private：只有用户显式授权过的 origin 才放行。
  // loopback and private: only an origin the user explicitly allowed gets through.
  if (options.allowedPrivateOrigins?.has(url.origin)) return { allowed: true, zone };
  return { allowed: false, zone, reason: describeNetworkZone(zone) };
};

/**
 * 重定向落点的复核。
 *
 * 比 {@link evaluateNetworkTarget} 更严一档：从公网跳进内网/回环，即便落点 origin 在白名单
 * 里也拒绝。白名单表达的是「用户想预览这个本地服务」，而不是「任何公网页面都可以把 Agent
 * 引到这个本地服务上」—— 后者正是 SSRF 想要的那一跳。
 *
 * Re-check of a redirect's destination, one notch stricter than {@link evaluateNetworkTarget}:
 * a hop from public into private or loopback is refused even when the destination origin is
 * allowlisted. The allowlist means "the user wants to preview this local service", not "any
 * public page may steer the agent into this local service" — and the latter is exactly the hop
 * an SSRF is after.
 */
export const evaluateRedirect = (
  fromUrl: string,
  toUrl: string,
  options: BrowserNetworkOptions = {}
): BrowserNetworkVerdict => {
  const destination = evaluateNetworkTarget(toUrl, options);
  if (!destination.allowed) return destination;

  let fromZone: BrowserNetworkZone;
  try {
    fromZone = classifyHostname(new URL(fromUrl).hostname);
  } catch {
    // 起点解析不出来就当公网处理，这是更保守的一侧。
    // An unparseable origin is treated as public, which is the conservative side.
    fromZone = 'public';
  }

  if (fromZone === 'public' && destination.zone !== 'public') {
    return {
      allowed: false,
      zone: destination.zone,
      reason: 'A public page may not redirect the in-app browser into a local or private address.',
    };
  }
  return destination;
};

/**
 * 连接前对已解析 IP 的复核 —— DNS rebinding 的那道闸。
 *
 * 域名判定挡不住 rebinding：`evil.example.com` 名字上是公网，第二次解析却可以返回
 * 127.0.0.1。所以真正建连用的地址必须单独再查一次：URL 属于公网层，解析结果却落在
 * 回环/内网/链路本地，就是 rebinding，直接拒绝。
 *
 * Re-check of the address actually resolved, immediately before connecting — the DNS-rebinding
 * gate. Name-based classification cannot catch rebinding: `evil.example.com` is public by name,
 * yet a second lookup may answer 127.0.0.1. When the URL classifies as public but the resolved
 * address does not, that mismatch is the rebinding, and it is refused.
 */
export const evaluateResolvedAddress = (
  rawUrl: string,
  resolvedAddress: string,
  options: BrowserNetworkOptions = {}
): BrowserNetworkVerdict => {
  const target = evaluateNetworkTarget(rawUrl, options);
  if (!target.allowed) return target;

  const resolvedZone = classifyHostname(resolvedAddress);
  if (resolvedZone === target.zone) return target;
  if (resolvedZone === 'public') return target;

  // 用户授权过的内网 origin 解析到内网地址是预期之中的，不该被自己的白名单绊倒。
  // An allowlisted private origin resolving to a private address is expected, and must not be
  // tripped up by its own allowlist entry.
  if (target.zone !== 'public') return target;

  return {
    allowed: false,
    zone: resolvedZone,
    reason: `${new URL(rawUrl).hostname} resolved to ${resolvedAddress}, a ${resolvedZone} address. Refusing the connection.`,
  };
};
