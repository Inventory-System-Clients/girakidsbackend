// Modelo de provedor de pagamento. Copie este arquivo para integrar o banco
// escolhido e implemente as funções com a API dele. O restante do sistema
// (checkout, webhook, conciliação e alertas) já usa esta interface.
//
// Variáveis de ambiente sugeridas: PAGAMENTO_API_URL, PAGAMENTO_API_KEY,
// PAGAMENTO_WEBHOOK_SECRET.

export default {
  nome: "modelo",

  // Métodos que este provedor cobra online (códigos de utils/formasPagamento).
  metodos: ["PIX_ONLINE", "CREDITO_ONLINE", "DEBITO_ONLINE"],

  // true quando as credenciais estão no .env.
  configurado() {
    return Boolean(process.env.PAGAMENTO_API_URL && process.env.PAGAMENTO_API_KEY);
  },

  // Cria a cobrança de um pedido. Deve devolver:
  //   { referencia, link?, qrCode?, copiaECola?, expiraEm? }
  // eslint-disable-next-line no-unused-vars
  async criarCobranca({ pedido, metodo, parcelas }) {
    throw new Error("Provedor de pagamento ainda não implementado.");
  },

  // Consulta a situação de uma cobrança. Deve devolver:
  //   { status: "PAGO" | "PENDENTE" | "RECUSADO" | "EXPIRADO", valorPago? }
  // eslint-disable-next-line no-unused-vars
  async consultarCobranca(referencia) {
    throw new Error("Provedor de pagamento ainda não implementado.");
  },

  // Valida e interpreta o webhook do banco. Deve devolver:
  //   { referencia, status, valorPago, eventoId, bruto }
  // ou lançar erro se a assinatura for inválida.
  // eslint-disable-next-line no-unused-vars
  async interpretarWebhook(req) {
    throw new Error("Provedor de pagamento ainda não implementado.");
  },
};
