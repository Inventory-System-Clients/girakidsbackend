import { credenciaisDe, urlFrontend } from "./config.js";
import { erroHttp, somenteDigitos } from "../../utils/helpers.js";

// SumUp (copiado e adaptado do Dubob):
// - PIX online: checkout com QR Code e copia e cola na tela;
// - cartão online: página de pagamento hospedada pela SumUp;
// - maquininha: cobrança enviada para a tela do reader pareado (Cloud API).
// A SumUp não depende de webhook: o status vem sempre de consulta à API
// (tela de pagamento + conciliação automática do backend).
const API = process.env.SUMUP_API_URL || "https://api.sumup.com";

const chamar = async (metodo, caminho, corpo, credenciais = credenciaisDe("sumup")) => {
  if (!credenciais?.apiKey) throw erroHttp(400, "SumUp sem API key. Configure na aba Pagamentos.");
  const resposta = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${credenciais.apiKey}`, "Content-Type": "application/json" },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const texto = await resposta.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { texto };
  }
  if (!resposta.ok) {
    const detalhe = dados.message || dados.error_message || dados.detail || dados.texto || resposta.status;
    const erro = erroHttp(resposta.status === 401 ? 400 : 502, resposta.status === 401 ? "A SumUp recusou a API key." : `SumUp: ${detalhe}`);
    erro.statusProvedor = resposta.status;
    throw erro;
  }
  return dados;
};

const merchant = async () => {
  const credenciais = credenciaisDe("sumup");
  if (credenciais?.merchantCode) return credenciais.merchantCode;
  const eu = await chamar("GET", "/v0.1/me");
  return String(eu?.merchant_profile?.merchant_code || "");
};

const descricao = (pedido) => `Pedido Gira Kids ${pedido.numeroFormatado || pedido.numero}`;
const centavos = (valor) => Math.round(Number(valor) * 100);

const lerArtefato = async (artefato) => {
  if (!artefato) return null;
  if (artefato.content) return String(artefato.content);
  if (!artefato.location) return null;
  const resposta = await fetch(artefato.location, { headers: { Authorization: `Bearer ${credenciaisDe("sumup")?.apiKey}` } });
  return resposta.ok ? (await resposta.text()).trim() : null;
};

const criarCheckout = async (pedido, extras = {}) => {
  const checkout = await chamar("POST", "/v0.1/checkouts", {
    checkout_reference: `${pedido.id}-${Date.now()}`,
    amount: Number(Number(pedido.total).toFixed(2)),
    currency: "BRL",
    merchant_code: await merchant(),
    description: descricao(pedido),
    ...extras,
  });
  if (!checkout?.id) throw erroHttp(502, "A SumUp não criou o checkout.");
  return checkout;
};

export default {
  nome: "sumup",
  rotulo: "SumUp",
  canais: ["online", "maquininha"],
  metodos: ["PIX_ONLINE", "CREDITO_ONLINE", "DEBITO_ONLINE"],
  campos: [{ chave: "apiKey", rotulo: "API key (sup_sk_...)", secreto: true, obrigatorio: true, dica: "SumUp → Configurações → Para desenvolvedores → Chaves de API. Para PIX online, o PIX precisa estar ativo na conta." }],
  webhook: false,
  ajudaMaquininha: "Pareie pelo código que aparece na maquininha (Menu → Conexões → API → Conectar) ou escolha uma já conectada à conta.",

  configurado() {
    return Boolean(credenciaisDe("sumup")?.apiKey);
  },

  // Valida a chave e guarda o merchant_code junto.
  async validarCredenciais(credenciais) {
    const eu = await chamar("GET", "/v0.1/me", undefined, credenciais);
    const merchantCode = eu?.merchant_profile?.merchant_code;
    if (!merchantCode) throw erroHttp(400, "A SumUp não devolveu o código da loja para esta chave.");
    return { conta: eu?.merchant_profile?.company_name || merchantCode, extras: { merchantCode: String(merchantCode) } };
  },

  async criarCobranca({ pedido, metodo }) {
    if (metodo === "PIX_ONLINE") {
      const checkout = await criarCheckout(pedido);
      const [primeiro, ...resto] = String(pedido.clienteNome || "").trim().split(/\s+/);
      const documento = somenteDigitos(pedido.documento);
      const processado = await chamar("PUT", `/v0.1/checkouts/${checkout.id}`, {
        payment_type: "pix",
        personal_details: {
          ...(pedido.clienteEmail ? { email: pedido.clienteEmail } : {}),
          ...(primeiro ? { first_name: primeiro } : {}),
          ...(resto.length ? { last_name: resto.join(" ") } : {}),
          ...(documento ? { tax_id: documento } : {}),
        },
      });
      const artefatos = processado?.artefacts || processado?.next_step?.artefacts || [];
      const achar = (nome) => artefatos.find((a) => String(a?.name || "").toLowerCase() === nome);
      const copiaECola = await lerArtefato(achar("code"));
      if (!copiaECola) throw erroHttp(502, "A SumUp não gerou o PIX. Confira se o PIX online está ativo na conta SumUp.");
      return { referencia: `checkout:${checkout.id}`, copiaECola };
    }
    const checkout = await criarCheckout(pedido, {
      hosted_checkout: { enabled: true },
      redirect_url: `${urlFrontend()}/pagamento/${pedido.id}`,
    });
    if (!checkout.hosted_checkout_url) throw erroHttp(502, "A SumUp não devolveu a página de pagamento.");
    return { referencia: `checkout:${checkout.id}`, link: checkout.hosted_checkout_url };
  },

  // O valor pago volta junto: quem confirma compara com o total do pedido.
  async consultarCobranca(referencia) {
    const [tipo, ...resto] = String(referencia).split(":");
    if (tipo === "checkout") {
      const checkout = await chamar("GET", `/v0.1/checkouts/${resto.join(":")}`);
      const status = String(checkout?.status || "").toUpperCase();
      if (status === "PAID") return { status: "PAGO", valorPago: Number(checkout.amount) };
      if (status === "FAILED") return { status: "RECUSADO" };
      if (status === "EXPIRED") return { status: "EXPIRADO" };
      return { status: "PENDENTE" };
    }
    if (tipo === "reader") {
      const [, clientTransactionId] = resto;
      if (!clientTransactionId) return { status: "PENDENTE" };
      try {
        const venda = await chamar("GET", `/v2.1/merchants/${await merchant()}/transactions?client_transaction_id=${encodeURIComponent(clientTransactionId)}`);
        const status = String(venda?.status || "").toUpperCase();
        if (status === "SUCCESSFUL") return { status: "PAGO", valorPago: Number(venda.amount) };
        if (["FAILED", "CANCELLED"].includes(status)) return { status: "RECUSADO" };
      } catch (error) {
        if (error.statusProvedor !== 404) throw error; // 404 = ainda não pago
      }
      return { status: "PENDENTE" };
    }
    return { status: "PENDENTE" };
  },

  async interpretarWebhook() {
    return { ignorar: true };
  },

  async cobrarMaquininha({ pedido, maquininha }) {
    const dados = await chamar("POST", `/v0.1/merchants/${await merchant()}/readers/${maquininha.identificador}/checkout`, {
      total_amount: { currency: "BRL", minor_unit: 2, value: centavos(pedido.total) },
      description: descricao(pedido),
    });
    const resposta = dados.data || dados;
    return { referencia: `reader:${maquininha.identificador}:${resposta.client_transaction_id || ""}` };
  },

  async cancelarMaquininha(referencia) {
    const [, readerId] = String(referencia).split(":");
    await chamar("POST", `/v0.1/merchants/${await merchant()}/readers/${readerId}/terminate`).catch(() => {});
  },

  // Pareamento de maquininhas (aba Pagamentos).
  async listarReaders() {
    const dados = await chamar("GET", `/v0.1/merchants/${await merchant()}/readers`);
    const itens = Array.isArray(dados) ? dados : dados.items || dados.readers || dados.data || [];
    return itens.map((r) => ({ id: String(r.id || r.reader_id), nome: r.name || null, status: r.status || null, serial: r.device?.identifier || null, modelo: r.device?.model || null }));
  },

  async parearReader(codigo, nome) {
    const dados = await chamar("POST", `/v0.1/merchants/${await merchant()}/readers`, { pairing_code: String(codigo).trim().toUpperCase(), ...(nome ? { name: nome } : {}) });
    if (!dados.id) throw erroHttp(502, "A SumUp não devolveu o id da maquininha.");
    return { id: String(dados.id), status: dados.status || null };
  },
};
