import { credenciaisDe } from "./config.js";
import { erroHttp } from "../../utils/helpers.js";

// Stone Connect 2.0 (copiado e adaptado do Dubob): API da Pagar.me (grupo
// Stone). O pedido aberto com o número de série aparece direto na tela da
// maquininha. O webhook (charge.paid) só avisa; o status vem da consulta.
const API = process.env.STONE_API_URL || "https://api.pagar.me/core/v5";
const TIPOS = ["", "debit", "credit", "voucher", "pix"];

const chamar = async (metodo, caminho, corpo, credenciais = credenciaisDe("stone")) => {
  if (!credenciais?.secretKey) throw erroHttp(400, "Stone sem Secret Key. Configure na aba Pagamentos.");
  const resposta = await fetch(`${API}${caminho}`, {
    method: metodo,
    headers: {
      Authorization: `Basic ${Buffer.from(`${credenciais.secretKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      ...(credenciais.serviceRefererName ? { ServiceRefererName: credenciais.serviceRefererName } : {}),
    },
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
    const erro = erroHttp(resposta.status === 401 ? 400 : 502, resposta.status === 401 ? "A Stone recusou a Secret Key." : `Stone: ${dados.message || dados.texto || resposta.status}`);
    erro.statusProvedor = resposta.status;
    throw erro;
  }
  return dados;
};

const pagas = (ordem) => (ordem?.charges || []).filter((c) => String(c.status || "").toLowerCase() === "paid");
const valorPago = (ordem) => pagas(ordem).reduce((s, c) => s + Number(c.paid_amount ?? c.amount ?? 0), 0) / 100;

const situacao = (ordem, totalCentavos) => {
  const status = String(ordem?.status || "").toLowerCase();
  const pago = valorPago(ordem);
  if (status === "paid" || (pago > 0 && Math.round(pago * 100) >= totalCentavos)) return { status: "PAGO", valorPago: pago || totalCentavos / 100 };
  if (["canceled", "failed"].includes(status)) return { status: "RECUSADO" };
  return { status: "PENDENTE" };
};

export default {
  nome: "stone",
  rotulo: "Stone",
  canais: ["maquininha"],
  metodos: [],
  campos: [
    { chave: "secretKey", rotulo: "Secret Key (sk_...)", secreto: true, obrigatorio: true, dica: "Partner Hub da Stone (Integração → Setup → Connect Stone) ou Dashboard Pagar.me (Desenvolvimento → Chaves)." },
    { chave: "serviceRefererName", rotulo: "ServiceRefererName (identificador de parceiro)", dica: "Enviado pela Stone no cadastro de parceria." },
    { chave: "tipoPagamento", rotulo: "Forma na maquininha", opcoes: { "": "Cliente escolhe na maquininha", debit: "Débito", credit: "Crédito à vista", pix: "PIX", voucher: "Voucher" } },
  ],
  webhook: true,
  ajudaMaquininha: "Identificador: o número de série da maquininha Stone.",

  configurado() {
    return Boolean(credenciaisDe("stone")?.secretKey);
  },

  async validarCredenciais(credenciais) {
    if (credenciais.tipoPagamento && !TIPOS.includes(credenciais.tipoPagamento)) throw erroHttp(400, "Forma de pagamento da Stone inválida.");
    await chamar("GET", "/orders?page=1&size=1", undefined, credenciais);
    return { conta: "Stone" };
  },

  async criarCobranca() {
    throw erroHttp(400, "A Stone é usada só na maquininha.");
  },

  async consultarCobranca(referencia, pedido) {
    const [, id] = String(referencia).split(":");
    const ordem = await chamar("GET", `/orders/${id}`);
    const resultado = situacao(ordem, Math.round(Number(pedido?.total || 0) * 100));
    // Obrigatório fechar depois de pago, senão a maquininha para de listar pedidos.
    if (resultado.status === "PAGO" && String(ordem.status || "").toLowerCase() !== "paid") {
      await chamar("PATCH", `/orders/${id}/closed`, { status: "paid" }).catch(() => {});
    }
    return resultado;
  },

  // charge.paid: o corpo não é confiado; só diz qual pedido consultar.
  async interpretarWebhook(req) {
    const id = String(req.body?.data?.order?.id || "").trim();
    if (!id) return { ignorar: true };
    const ordem = await chamar("GET", `/orders/${id}`);
    const total = Math.round(Number(ordem.amount || 0));
    return { referencia: `stone:${id}`, ...situacao(ordem, total), eventoId: req.body?.id || id, bruto: { id, status: ordem.status } };
  },

  async cobrarMaquininha({ pedido, maquininha }) {
    const credenciais = credenciaisDe("stone") || {};
    const centavos = Math.round(Number(pedido.total) * 100);
    const codigo = `GK${pedido.numero}${Date.now().toString(36)}`.slice(0, 52);
    const ordem = await chamar("POST", "/orders", {
      code: codigo,
      items: [{ amount: centavos, description: `Pedido Gira Kids ${pedido.numeroFormatado || pedido.numero}`, quantity: 1, code: codigo }],
      customer: { name: pedido.clienteNome || "Cliente Gira Kids" },
      closed: false,
      poi_payment_settings: {
        visible: true,
        display_name: `Pedido ${pedido.numeroFormatado || pedido.numero}`,
        print_order_receipt: false,
        devices_serial_number: [maquininha.identificador],
        ...(credenciais.tipoPagamento ? { payment_setup: { type: credenciais.tipoPagamento, installments: 1, installment_type: "merchant" } } : {}),
      },
    });
    if (!ordem?.id) throw erroHttp(502, "A Stone não criou o pedido.");
    return { referencia: `stone:${ordem.id}` };
  },

  async cancelarMaquininha(referencia) {
    const [, id] = String(referencia).split(":");
    await chamar("PATCH", `/orders/${id}/closed`, { status: "canceled" }).catch(() => {});
  },
};
