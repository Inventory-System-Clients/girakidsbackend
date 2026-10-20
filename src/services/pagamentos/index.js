// Camada de pagamentos online — deixada aberta para conectar o banco/gateway
// de recebimento escolhido (Mercado Pago, PagSeguro, Asaas, Stone, Cielo,
// Getnet, Rede, Banco Inter, Efí...).
//
// Para conectar um banco:
//   1. Crie um arquivo nesta pasta (ex.: asaas.js) exportando um objeto com a
//      mesma interface do `modelo.js`.
//   2. Registre-o em PROVEDORES abaixo.
//   3. Defina PAGAMENTO_PROVEDOR=<nome> (e as credenciais) no .env.
//   4. Aponte o webhook do banco para POST /api/pagamentos/webhook/<nome>.
//
// Sem provedor configurado, PIX online e cartão online ficam indisponíveis no
// checkout e todos os pedidos seguem pelo fluxo manual (Time Financeiro
// confirma o recebimento).
import modelo from "./modelo.js";

const PROVEDORES = {
  modelo,
};

export const provedorAtivo = () => {
  const nome = process.env.PAGAMENTO_PROVEDOR;
  if (!nome) return null;
  const provedor = PROVEDORES[nome];
  if (!provedor) {
    console.warn(`[Pagamentos] Provedor "${nome}" não registrado.`);
    return null;
  }
  return provedor.configurado() ? provedor : null;
};

export const obterProvedor = (nome) => PROVEDORES[nome] || null;

export const statusPagamentos = () => {
  const provedor = provedorAtivo();
  return {
    habilitado: Boolean(provedor),
    provedor: provedor?.nome || null,
    metodos: provedor?.metodos || [],
  };
};
