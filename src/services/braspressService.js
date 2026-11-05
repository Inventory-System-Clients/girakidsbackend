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
  const pedir = async (caminho, { method = "GET", form, corpoBruto, headers = {} } = {}) => {
    let url = new URL(caminho, BASE).toString();
    let corpo = corpoBruto ?? (form ? new URLSearchParams(form).toString() : undefined);
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

const REMETENTE = { cnpj: "17440365000130", cep: "03551000" };
const br = (n, casas = 2) => Number(n || 0).toFixed(casas).replace(".", ",");
const formatarDoc = (d) =>
  d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
const textoPuro = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const ajaxJson = async (sessao, caminho, form) => {
  const r = await sessao.pedir(caminho, { method: "POST", form, headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" } });
  try {
    return JSON.parse(r.texto);
  } catch {
    return null;
  }
};

// Cotação rodoviária CIF (pagante = Gira Kids). caixa em cm; peso em kg.
// Devolve o valor e o prazo do site, sem acréscimos, e o texto da resposta.
export const cotarBraspressSite = async ({ cepDestino, documentoDestino, pesoKg, valorMercadoria, volumes = 1, caixa }) => {
  const { sessao, pagina } = await entrarBraspress();
  const html = pagina.texto;
  const cep = String(cepDestino).replace(/\D/g, "");
  const [filialOrigem, filialDestino] = await Promise.all([
    ajaxJson(sessao, "/site/ajax/getFilialByCEP", { cep: REMETENTE.cep }),
    ajaxJson(sessao, "/site/ajax/getFilialByCEP", { cep }),
  ]);
  if (!filialDestino?.idFilial) throw new Error("A Braspress não atende o CEP de destino.");
  let doc = String(documentoDestino || "").replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) doc = REMETENTE.cnpj;
  const [remetente, destinatario] = await Promise.all([
    ajaxJson(sessao, "/site/ajax/getCliente", { cnpj: REMETENTE.cnpj }),
    ajaxJson(sessao, "/site/ajax/getCliente", { cnpj: doc }),
  ]);
  const end = filialDestino.endereco || {};
  const form = new URLSearchParams();
  form.append("email", valorCampo(html, "email") || "");
  form.append("modal", "R");
  form.append("tipoFrete", "1");
  form.append("cnpjRemetenteStr", formatarDoc(REMETENTE.cnpj));
  form.append("razaoSocialRemetente", remetente?.razao || "");
  form.append("cnpjDestinatarioStr", formatarDoc(doc));
  form.append("razaoSocialDestinatario", destinatario?.razao || "");
  form.append("cnpjConsignadoStr", "");
  form.append("razaoSocialConsignado", "");
  form.append("cepOrigem", REMETENTE.cep);
  form.append("filialOrigem", String(filialOrigem?.idFilial || ""));
  form.append("cepDestino", cep);
  form.append("filialDestino", String(filialDestino.idFilial));
  form.append("endereco", [end.logradouro, end.bairro, end.cidade, end.uf].filter(Boolean).join(" - "));
  form.append("volumes", String(volumes));
  form.append("peso", br(Math.max(0.1, pesoKg)));
  form.append("vlrMercadoria", br(valorMercadoria));
  form.append("cubagem[0].comprimento", br(caixa.comprimento / 100));
  form.append("cubagem[0].largura", br(caixa.largura / 100));
  form.append("cubagem[0].altura", br(caixa.altura / 100));
  form.append("cubagem[0].volumes", String(volumes));
  for (const m of html.matchAll(/<input type="hidden" name="(as_sfid|as_fid)" value="([^"]*)"/gi)) form.append(m[1], m[2]);
  const r = await sessao.pedir("/site/w/cotacao/calcular", {
    method: "POST",
    headers: { "X-Requested-With": "XMLHttpRequest" },
    corpoBruto: form.toString(),
  });
  const texto = textoPuro(r.texto);
  const valor = texto.match(/(?:total|valor)[^R$]{0,60}R\$\s*([\d.]+,\d{2})/i)?.[1];
  const prazo = texto.match(/prazo[^\d]{0,60}(\d{1,3})\s*dia/i)?.[1];
  return {
    valor: valor ? Number(valor.replace(/\./g, "").replace(",", ".")) : null,
    prazoDias: prazo ? Number(prazo) : null,
    status: r.status,
    texto: texto.slice(0, 3000),
  };
};
