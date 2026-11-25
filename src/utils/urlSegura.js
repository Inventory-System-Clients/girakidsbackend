import dns from "dns/promises";
import net from "net";

// Proteção contra SSRF: o servidor só busca URLs públicas http(s). Bloqueia
// localhost, redes privadas, link-local (169.254.x — metadados da nuvem),
// CGNAT, multicast e equivalentes IPv6, inclusive depois de resolver o DNS e
// a cada redirecionamento.

const privadoV4 = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
};

const privadoV6 = (ip) => {
  const t = ip.toLowerCase();
  if (t === "::" || t === "::1") return true;
  const v4 = t.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return privadoV4(v4[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(t);
};

export const ipPrivado = (ip) => (net.isIPv4(ip) ? privadoV4(ip) : net.isIPv6(ip) ? privadoV6(ip) : true);

const erro = (mensagem) => Object.assign(new Error(mensagem), { status: 400 });

// Lança erro se a URL não for http(s) pública.
export const garantirUrlPublica = async (valor) => {
  let url;
  try {
    url = new URL(String(valor));
  } catch {
    throw erro("URL inválida.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw erro("Só são aceitas URLs http ou https.");
  if (url.username || url.password) throw erro("URL não pode ter usuário e senha.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw erro("Endereço interno não permitido.");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (!ips.length) throw erro("Não foi possível resolver o endereço.");
  if (ips.some(ipPrivado)) throw erro("Endereço interno não permitido.");
  return url;
};

// fetch que só segue redirecionamentos para endereços públicos.
export const fetchPublico = async (valor, opcoes = {}, saltos = 3) => {
  const url = await garantirUrlPublica(valor);
  const resposta = await fetch(url, { ...opcoes, redirect: "manual" });
  if (resposta.status >= 300 && resposta.status < 400 && resposta.headers.get("location")) {
    if (saltos <= 0) throw erro("Redirecionamentos demais.");
    return fetchPublico(new URL(resposta.headers.get("location"), url).toString(), opcoes, saltos - 1);
  }
  return resposta;
};
