/**
 * SSRF 防护：在发起任何出站 HTTP 请求前校验目标 URL。
 *
 * 两层校验：
 *  1) 字面量/协议层：协议必须为 http/https；禁止 localhost、链路本地、
 *     私网保留地址的字面量写法。
 *  2) DNS 解析层：把主机名解析为 IP 后，确认没有指向内网/保留段
 *     （10/172.16-31/192.168/169.254/127 等），覆盖「域名解析到内网」的情况。
 *
 * 任何一层不通过都直接抛错，请求不会真正发出。
 */

import net from "node:net";
import { lookup } from "node:dns/promises";

/** HTTP 响应体字节上限（8MB），超限即报错，防止内存耗尽 DoS */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 判断一个 IP 是否属于私网/保留/链路本地段 */
function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) !== 4) {
    // IPv6
    const v = ip.toLowerCase();
    if (v === "::1") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) {
      return true;
    }
    // IPv4-mapped IPv6，递归判断内嵌的 IPv4
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return false;
  }
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  if (p[0] === 0) return true; // 0.0.0.0/0
  if (p[0] === 10) return true;
  if (p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true; // 链路本地 / 云元数据 169.254.169.254
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function checkLiteralHost(host: string): void {
  const h = host.toLowerCase();
  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]"
  ) {
    throw new Error(`已拦截本地地址：${host}`);
  }
  if (h.startsWith("169.254.")) {
    throw new Error(`已拦截链路本地/元数据地址：${host}`);
  }
  if (net.isIP(h) > 0 && isPrivateIp(h)) {
    throw new Error(`已拦截内网/保留地址：${host}`);
  }
}

/**
 * 校验 URL 安全性，安全则返回原 URL。异步（含 DNS 解析层）。
 * 纯 IP 字面量在字面量层已校验，跳过 DNS 解析直接放行，避免依赖网络环境。
 */
export async function assertSafeUrl(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`非法 URL：${raw}`);
  }
  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    throw new Error(`仅允许 http/https 协议，已拦截：${proto}//`);
  }
  const host = u.hostname.toLowerCase();
  checkLiteralHost(host);

  // 纯 IP 字面量：字面量层已校验，无需 DNS
  if (net.isIP(host) > 0) return raw;

  // 域名：DNS 解析层，确认解析结果不指向内网
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    // 解析失败（含纯 IP 已提前返回，这里只可能是域名）一律拒绝，避免 SSRF 探测
    throw new Error(`无法解析主机，已拒绝请求：${host}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(`目标解析到内网/保留地址，已拦截：${address}`);
    }
  }
  return raw;
}
