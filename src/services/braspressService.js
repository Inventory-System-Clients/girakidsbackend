// Cotação de frete na Braspress pelo site de clientes (blue.braspress.com),
// com o login da Gira Kids (BRASPRESS_USER / BRASPRESS_PASSWORD na Render).
// O site é um formulário comum (sem captcha no login): basta manter os cookies.

const BASE = "https://blue.braspress.com";
const AGENTE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const braspressConfigurada = () => Boolean(process.env.BRASPRESS_USER && process.env.BRASPRESS_PASSWORD);

// Sessão com cookie jar simples (o site usa JSESSIONID e afins).
const novaSessao = () => {
  const cookies = new Map();
  const guardar = (resposta) => {
    for (const c of resposta.headers.getSetCookie?.() || []) {
      const [par] = c.split(";");
      const i = par.indexOf("=");
      if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  };
  const pedir = async (caminho, { method = "GET", form, headers = {} } = {}) => {
    let url = new URL(caminho, BASE).toString();
    let corpo = form ? new URLSearchParams(form).toString() : undefined;
    let metodo = method;
    // Segue redirecionamentos à mão para não perder os cookies de cada passo.
    for (let i = 0; i < 8; i += 1) {
      const resposta = await fetch(url, {
        method: metodo,
        redirect: "manual",
        headers: {
          "User-Agent": AGENTE,
          Accept: "text/html,application/json,*/*",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(corpo ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
          ...headers,
        },
        body: corpo,
        signal: AbortSignal.timeout(30000),
      });
      guardar(resposta);
      const destino = resposta.headers.get("location");
      if (resposta.status >= 300 && resposta.status < 400 && destino) {
        url = new URL(destino, url).toString();
        metodo = "GET";
        corpo = undefined;
        continue;
      }
      return { status: resposta.status, url, texto: await resposta.text() };
    }
    throw new Error("Braspress: redirecionamentos demais.");
  };
  return { pedir };
};

const valorCampo = (html, nome) => html.match(new RegExp(`name="${nome}"[^>]*value="([^"]*)"`, "i"))?.[1] ?? "";

// Entra no site e devolve a sessão já na tela de cotação.
export const entrarBraspress = async () => {
  if (!braspressConfigurada()) throw new Error("Braspress não configurada (BRASPRESS_USER / BRASPRESS_PASSWORD).");
  const sessao = novaSessao();
  const tela = await sessao.pedir("/site/w/cotacao/view");
  const login = await sessao.pedir("/site/w/auth", {
    method: "POST",
    form: {
      callback: valorCampo(tela.texto, "callback") || "/w/cotacao/view",
      title: valorCampo(tela.texto, "title") || "Cotação online",
      loginMode: valorCampo(tela.texto, "loginMode"),
      msgInfo: valorCampo(tela.texto, "msgInfo"),
      CSRF_TOKEN: valorCampo(tela.texto, "CSRF_TOKEN"),
      login: String(process.env.BRASPRESS_USER).replace(/\D/g, "") || process.env.BRASPRESS_USER,
      pass: process.env.BRASPRESS_PASSWORD,
    },
  });
  if (/name="pass"/i.test(login.texto)) {
    const erro = login.texto.match(/login-error[\s\S]*?<center>([^<]*)<\/center>/i)?.[1]?.trim();
    throw new Error(`Braspress recusou o login${erro ? `: ${erro}` : "."}`);
  }
  return { sessao, pagina: login };
};

// Diagnóstico (só ADMIN): estrutura da tela de cotação depois do login, para
// mapear os campos. Não devolve cookies nem credenciais.
export const diagnosticoBraspress = async () => {
  const { pagina } = await entrarBraspress();
  const html = pagina.texto;
  const forms = [...html.matchAll(/<form[^>]*>/gi)].map((m) => m[0]);
  const campos = [...html.matchAll(/<(input|select|textarea)[^>]*>/gi)]
    .map((m) => m[0].replace(/value="[^"]{40,}"/i, 'value="…"'))
    .filter((t) => !/type="password"/i.test(t));
  const opcoes = [...html.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)].map((m) => ({
    nome: m[1],
    opcoes: [...m[2].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/gi)].slice(0, 15).map((o) => `${o[1]}=${o[2].trim()}`),
  }));
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]);
  const trechosJs = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((js) => /ajax|url|\$\.post|\$\.get|fetch|submit|cotac/i.test(js) && !/NS_CSM|google-analytics/.test(js))
    .map((js) => js.slice(0, 4000));
  return { status: pagina.status, url: pagina.url, tamanho: html.length, forms, campos, opcoes, scripts, trechosJs };
};
