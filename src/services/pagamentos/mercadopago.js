import crypto from "crypto";
import { credenciaisDe, urlBackend, urlFrontend } from "./config.js";
import { erroHttp, somenteDigitos } from "../../utils/helpers.js";

// Mercado Pago (copiado e adaptado do Dubob):
// - PIX online: pagamento PIX direto (QR Code e copia e cola na tela);
// - cartão online: Checkout Pro (página do Mercado Pago);
// - maquininha: Mercado Pago Point pela API /v1/orders.
// A confirmação vem do webhook (assinatura x-signature) e, de qualquer forma,
// o status é sempre lido na API do Mercado Pago, nunca do corpo recebido.
// API_URL trocável só para testes locais com um simulador.
const API = process.env.MERCADOPAGO_API_URL || "https://api.mercadopago.com";

const STATUS = {
  approved: "PAGO",
  authorized: "PAGO",
  rejected: "RECUSADO",
  cancelled: "RECUSADO",
  refunded: "RECUSADO",
  charged_back: "RECUSADO",
};

const token = (credenciais = credenciaisDe("mercadopago")) => {
  if (!credenciais?.accessToken) throw erroHttp(400, "Mercado Pago sem Access Token. Configure na aba Pagamentos.");
  return credenciais.accessToken;
};

const chamar = async (metodo, caminho, corpo, { credenciais, idempotencia } = {}) => {
  const resposta = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token(credenciais)}`,
      "Content-Type": "application/json",
      ...(idempotencia ? { "X-Idempotency-Key": idempotencia } : {}),
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
    const erro = erroHttp(resposta.status === 401 ? 400 : 502, resposta.status === 401 ? "O Mercado Pago recusou o Access Token." : `Mercado Pago: ${dados.message || dados.error || resposta.status}`);
    erro.statusProvedor = resposta.status;
    throw erro;
  }
  return dados;
};

const pagador = (pedido) => {
  const [primeiro, ...resto] = String(pedido.clienteNome || "Cliente").trim().split(/\s+/);
  const documento = somenteDigitos(pedido.documento);
  return {
    email: pedido.clienteEmail || "cliente@girakids.com.br",
    first_name: primeiro,
    last_name: resto.join(" ") || primeiro,
    ...(documento.length === 11 || documento.length === 14 ? { identification: { type: documento.length === 11 ? "CPF" : "CNPJ", number: documento } } : {}),
  };
};

const descricao = (pedido) => `Pedido Gira Kids ${pedido.numeroFormatado || pedido.numero}`;

export default {
  nome: "mercadopago",
  rotulo: "Mercado Pago",
  canais: ["online", "maquininha"],
  metodos: ["PIX_ONLINE", "CREDITO_ONLINE", "DEBITO_ONLINE"],
  campos: [
    { chave: "accessToken", rotulo: "Access Token de produção", secreto: true, obrigatorio: true, dica: "Mercado Pago → Suas integrações → Credenciais de produção (APP_USR-...)" },
    { chave: "webhookSecret", rotulo: "Assinatura secreta do webhook", secreto: true, dica: "Suas integrações → Webhooks → Assinatura secreta. Com ela, avisos falsos são descartados." },
  ],
  webhook: true,
  ajudaMaquininha: 'Identificador: o "terminal_id" da maquininha Point (Mercado Pago → Point → seus dispositivos), com ela em modo integrado (PDV).',

  configurado() {
    return Boolean(credenciaisDe("mercadopago")?.accessToken);
  },

  async validarCredenciais(credenciais) {
    const eu = await chamar("GET", "/users/me", null, { credenciais });
    return { conta: eu.nickname || eu.email || String(eu.id || "") };
  },

  async criarCobranca({ pedido, metodo, parcelas }) {
    const notificacao = `${urlBackend()}/api/pagamentos/webhook/mercadopago`;
    if (metodo === "PIX_ONLINE") {
      const pagamento = await chamar(
        "POST",
        "/v1/payments",
        {
          transaction_amount: Number(Number(pedido.total).toFixed(2)),
          description: descricao(pedido),
          payment_method_id: "pix",
          payer: pagador(pedido),
          external_reference: pedido.id,
          notification_url: notificacao,
          date_of_expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace("Z", "-00:00"),
        },
        { idempotencia: `pix-${pedido.id}-${Date.now()}` },
      );
      const dados = pagamento.point_of_interaction?.transaction_data || {};
      if (!dados.qr_code) throw erroHttp(502, "O Mercado Pago não gerou o PIX. Confira se a conta tem chave PIX cadastrada.");
      return { referencia: `pix:${pagamento.id}`, copiaECola: dados.qr_code, link: dados.ticket_url || null, expiraEm: pagamento.date_of_expiration || null };
    }

    // Cartão: Checkout Pro só com o tipo de cartão escolhido.
    const debito = metodo === "DEBITO_ONLINE";
    const voltar = `${urlFrontend()}/pagamento/${pedido.id}`;
    const preferencia = await chamar("POST", "/checkout/preferences", {
      items: [{ id: pedido.id, title: descricao(pedido), quantity: 1, unit_price: Number(Number(pedido.total).toFixed(2)), currency_id: "BRL" }],
      payer: { email: pedido.clienteEmail || undefined, name: pedido.clienteNome || undefined },
      external_reference: pedido.id,
      back_urls: { success: voltar, pending: voltar, failure: voltar },
      auto_return: "approved",
      notification_url: notificacao,
      statement_descriptor: "GIRAKIDS",
      payment_methods: {
        excluded_payment_types: [{ id: "ticket" }, { id: "bank_transfer" }, { id: "atm" }, ...(debito ? [{ id: "credit_card" }] : [{ id: "debit_card" }, { id: "prepaid_card" }])],
        installments: debito ? 1 : Math.max(1, Number(parcelas) || 12),
      },
    });
    return { referencia: `pref:${preferencia.id}`, link: preferencia.init_point };
  },

  async consultarCobranca(referencia, pedido) {
    const [tipo, id] = String(referencia).split(/:(.*)/s);
    if (tipo === "pix") {
      const pagamento = await chamar("GET", `/v1/payments/${id}`);
      return { status: STATUS[pagamento.status] || "PENDENTE", valorPago: pagamento.transaction_amount };
    }
    if (tipo === "point") {
      const ordem = await chamar("GET", `/v1/orders/${id}`);
      const status = String(ordem.status || "").toLowerCase();
      if (status === "processed") return { status: "PAGO", valorPago: Number(ordem.total_paid_amount || ordem.total_amount || pedido?.total) };
      if (["canceled", "expired", "failed", "refunded"].includes(status)) return { status: "RECUSADO" };
      return { status: "PENDENTE" };
    }
    // Checkout Pro: procura um pagamento aprovado com a referência do pedido.
    const busca = await chamar("GET", `/v1/payments/search?sort=date_created&criteria=desc&external_reference=${encodeURIComponent(pedido?.id || "")}`);
    const pagamentos = busca.results || [];
    const aprovado = pagamentos.find((p) => STATUS[p.status] === "PAGO");
    if (aprovado) return { status: "PAGO", valorPago: aprovado.transaction_amount };
    return { status: "PENDENTE" };
  },

  // Webhook: valida a assinatura (se configurada) e lê o pagamento na API.
  async interpretarWebhook(req) {
    const dataId = String(req.query["data.id"] || req.query.id || req.body?.data?.id || "");
    const tipo = req.body?.type || req.query.type || req.query.topic || "";
    const segredo = credenciaisDe("mercadopago")?.webhookSecret;
    if (segredo) {
      const partes = Object.fromEntries(String(req.get("x-signature") || "").split(",").map((p) => p.trim().split("=")));
      const modelo = `id:${dataId.toLowerCase()};request-id:${req.get("x-request-id") || ""};ts:${partes.ts || ""};`;
      const esperado = crypto.createHmac("sha256", segredo).update(modelo).digest("hex");
      const recebido = String(partes.v1 || "");
      if (recebido.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
        throw new Error("Assinatura do Mercado Pago inválida.");
      }
    }
    if (!dataId) return { ignorar: true };
    if (tipo === "order") {
      const ordem = await chamar("GET", `/v1/orders/${dataId}`);
      const st = String(ordem.status || "").toLowerCase();
      return {
        pedidoId: ordem.external_reference,
        referencia: `point:${ordem.id}`,
        status: st === "processed" ? "PAGO" : ["canceled", "expired", "failed"].includes(st) ? "RECUSADO" : "PENDENTE",
        valorPago: Number(ordem.total_paid_amount || ordem.total_amount || 0) || undefined,
        eventoId: ordem.id,
        bruto: { id: ordem.id, status: ordem.status },
      };
    }
    if (tipo && !["payment", "merchant_order"].includes(tipo)) return { ignorar: true };
    const pagamento = await chamar("GET", `/v1/payments/${dataId}`);
    return {
      pedidoId: pagamento.external_reference,
      referencia: `pix:${pagamento.id}`,
      status: STATUS[pagamento.status] || "PENDENTE",
      valorPago: pagamento.transaction_amount,
      eventoId: String(pagamento.id),
      bruto: { id: pagamento.id, status: pagamento.status, status_detail: pagamento.status_detail, metodo: pagamento.payment_method_id },
    };
  },

  // Maquininha Point: a cobrança aparece na tela dela.
  async cobrarMaquininha({ pedido, maquininha }) {
    const ordem = await chamar(
      "POST",
      "/v1/orders",
      {
        type: "point",
        external_reference: pedido.id,
        description: descricao(pedido),
        transactions: { payments: [{ amount: Number(pedido.total).toFixed(2) }] },
        config: { point: { terminal_id: maquininha.identificador, print_on_terminal: "no_ticket" } },
      },
      { idempotencia: `point-${pedido.id}-${Date.now()}` },
    );
    return { referencia: `point:${ordem.id}` };
  },

  async cancelarMaquininha(referencia) {
    const [, id] = String(referencia).split(/:(.*)/s);
    await chamar("POST", `/v1/orders/${id}/cancel`, {}, { idempotencia: `cancel-${id}-${Date.now()}` }).catch(() => {});
  },
};
