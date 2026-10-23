import crypto from "crypto";
import { credenciaisDe, urlBackend } from "./config.js";
import { erroHttp } from "../../utils/helpers.js";

// Getnet (Santander), com base no módulo oficial Getnet-Brasil/payment-magento:
// - login OAuth (client_credentials) com Client ID + Client Secret;
// - PIX online: QR Code dinâmico (v2/payments/qrcode/pix) mostrado no site;
//   a confirmação chega pela notificação da Getnet;
// - cartão (crédito/débito): Getpay — link de pagamento hospedado pela Getnet
//   (v1/payment-links), consultado na API até ser pago.
// A notificação da Getnet só traz o seller_id (que é público), então o
// endereço cadastrado na Getnet leva uma chave secreta gerada aqui
// (?chave=...); sem ela, a notificação é recusada.
const BASES = { producao: "https://api.getnet.com.br/", homologacao: "https://api-homologacao.getnet.com.br/" };
const base = (credenciais) => process.env.GETNET_API_URL || BASES[credenciais?.ambiente] || BASES.producao;

let tokenCache = { chave: "", token: "", expira: 0 };

const obterToken = async (credenciais) => {
  const chaveCache = `${credenciais.clientId}:${credenciais.ambiente}`;
  if (tokenCache.chave === chaveCache && tokenCache.expira > Date.now()) return tokenCache.token;
  const resposta = await fetch(`${base(credenciais)}auth/oauth/v2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${credenciais.clientId}:${credenciais.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=oob",
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok || !dados.access_token) throw erroHttp(400, "A Getnet recusou o Client ID / Client Secret.");
  tokenCache = { chave: chaveCache, token: dados.access_token, expira: Date.now() + Math.max(60, Number(dados.expires_in || 3600) - 300) * 1000 };
  return dados.access_token;
};

const exigirCredenciais = () => {
  const c = credenciaisDe("getnet");
  if (!c?.clientId || !c?.clientSecret || !c?.sellerId) throw erroHttp(400, "Getnet sem credenciais. Configure na aba Pagamentos.");
  return c;
};

const chamar = async (metodo, caminho, corpo, extrasCabecalho = {}) => {
  const credenciais = exigirCredenciais();
  const resposta = await fetch(`${base(credenciais)}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${await obterToken(credenciais)}`,
      "Content-Type": "application/json",
      seller_id: credenciais.sellerId,
      "x-seller-id": credenciais.sellerId,
      ...extrasCabecalho,
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await resposta.text();
  let dados = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { texto };
  }
  if (!resposta.ok) {
    const detalhe = dados.message || dados.details?.[0]?.description || dados.details?.[0]?.description_detail || dados.texto || resposta.status;
    const erro = erroHttp(502, `Getnet: ${detalhe}`);
    erro.statusProvedor = resposta.status;
    throw erro;
  }
  return dados;
};

const centavos = (valor) => Math.round(Number(valor) * 100);
const descricao = (pedido) => `Pedido Gira Kids ${pedido.numeroFormatado || pedido.numero}`;
// Data no formato da Getnet (UTC): "AAAA-MM-DD HH:MM:SS".
const dataGetnet = (d) => d.toISOString().slice(0, 19).replace("T", " ");

const STATUS_NOTIFICACAO = { APPROVED: "PAGO", PAID: "PAGO", DENIED: "RECUSADO", ERROR: "RECUSADO", CANCELED: "RECUSADO", CANCELLED: "RECUSADO" };

export default {
  nome: "getnet",
  rotulo: "Getnet",
  canais: ["online"],
  metodos: ["PIX_ONLINE", "CREDITO_ONLINE", "DEBITO_ONLINE"],
  campos: [
    { chave: "clientId", rotulo: "Client ID", secreto: true, obrigatorio: true, dica: "Portal do desenvolvedor Getnet → suas credenciais de produção." },
    { chave: "clientSecret", rotulo: "Client Secret", secreto: true, obrigatorio: true },
    { chave: "sellerId", rotulo: "Seller ID", obrigatorio: true, dica: "Identificador da loja na Getnet (ex.: 02a9952f-...)." },
    { chave: "ambiente", rotulo: "Ambiente", opcoes: { producao: "Produção", homologacao: "Homologação (testes)" } },
  ],
  webhook: true,
  ajudaWebhook: "Cadastre este endereço na Getnet como URL de notificação do PIX (inclui a chave secreta; não compartilhe).",

  // Endereço de notificação com a chave secreta desta loja.
  webhookUrl() {
    const chave = credenciaisDe("getnet")?.webhookToken;
    return chave ? `${urlBackend()}/api/pagamentos/webhook/getnet?chave=${chave}` : null;
  },

  configurado() {
    const c = credenciaisDe("getnet");
    return Boolean(c?.clientId && c?.clientSecret && c?.sellerId);
  },

  async validarCredenciais(credenciais) {
    tokenCache = { chave: "", token: "", expira: 0 };
    await obterToken(credenciais);
    return {
      conta: `Seller ${String(credenciais.sellerId).slice(0, 8)}…`,
      extras: { ambiente: credenciais.ambiente || "producao", webhookToken: credenciais.webhookToken || crypto.randomBytes(24).toString("base64url") },
    };
  },

  async criarCobranca({ pedido, metodo, parcelas }) {
    if (metodo === "PIX_ONLINE") {
      try {
        const pix = await chamar(
          "POST",
          "v2/payments/qrcode/pix",
          { amount: centavos(pedido.total), currency: "BRL", order_id: pedido.id, customer_id: pedido.clienteEmail || pedido.id },
          { "x-qrcode-expiration-time": "1800", "x-transaction-channel-entry": "MG" },
        );
        const codigo = pix.additional_data?.qr_code;
        if (pix.payment_id && codigo) {
          return { referencia: `pix:${pix.payment_id}`, copiaECola: codigo, expiraEm: new Date(Date.now() + 30 * 60 * 1000) };
        }
      } catch (error) {
        console.warn("[Getnet] PIX direto não gerado, usando link Getpay:", error.message);
      }
    }
    // Getpay: página da Getnet (cartão ou, na falta do PIX direto, PIX).
    const credito = metodo === "CREDITO_ONLINE";
    const link = await chamar("POST", "v1/payment-links", {
      label: "Gira Kids",
      expiration: dataGetnet(new Date(Date.now() + 2 * 86_400_000)),
      max_orders: 1,
      order: {
        product_type: "physical_goods",
        title: descricao(pedido),
        description: "Pagamento do pedido",
        order_prefix: String(pedido.numero),
        shipping_amount: 0,
        amount: centavos(pedido.total),
      },
      payment:
        metodo === "PIX_ONLINE"
          ? { pix: { enable: true } }
          : credito
            ? { credit: { enable: true, max_installments: Math.max(1, Number(parcelas) || 1) } }
            : { debit: { enable: true, caixa_virtual_card: false } },
    });
    if (!link.link_id || !link.url) throw erroHttp(502, "A Getnet não devolveu o link de pagamento.");
    return { referencia: `link:${link.link_id}`, link: link.url };
  },

  async consultarCobranca(referencia, pedido) {
    const [tipo, id] = String(referencia).split(/:(.*)/s);
    if (tipo === "link") {
      const link = await chamar("GET", `v1/payment-links/${id}`);
      if (Number(link.successful_orders || 0) >= 1) return { status: "PAGO", valorPago: Number(link.order?.amount ? link.order.amount / 100 : pedido?.total) };
      if (String(link.status || "").toUpperCase() === "EXPIRED") return { status: "EXPIRADO" };
      return { status: "PENDENTE" };
    }
    // PIX direto: confirmado pela notificação da Getnet.
    return { status: "PENDENTE" };
  },

  // Notificação da Getnet (GET ou POST). Só vale com a chave secreta do
  // endereço e o seller_id da loja.
  async interpretarWebhook(req) {
    const credenciais = exigirCredenciais();
    const recebida = String(req.query.chave || "");
    const esperada = String(credenciais.webhookToken || "");
    if (!esperada || recebida.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(recebida), Buffer.from(esperada))) {
      throw new Error("Chave da notificação Getnet inválida.");
    }
    const dados = { ...req.query, ...(req.body && typeof req.body === "object" ? req.body : {}) };
    if (dados.seller_id && dados.seller_id !== credenciais.sellerId) throw new Error("Notificação de outra loja Getnet.");
    const pagamentoId = String(dados.payment_id || dados.id || "");
    const status = STATUS_NOTIFICACAO[String(dados.status || "").toUpperCase()] || "PENDENTE";
    if (!pagamentoId || !dados.order_id) return { ignorar: true };
    return {
      pedidoId: dados.order_id,
      referencia: `pix:${pagamentoId}`,
      status,
      eventoId: pagamentoId,
      bruto: { payment_id: pagamentoId, status: dados.status, payment_type: dados.payment_type },
    };
  },
};
