// Pagamentos integrados aos bancos (aba Pagamentos, só ADMIN).
//
// Cada provedor (mercadopago.js, sumup.js, stone.js) segue a interface do
// modelo.js. O admin escolhe na aba Pagamentos qual banco cobra cada canal:
//   online      — PIX QR Code e cartão no checkout do site;
//   maquininha  — cobrança enviada para a maquininha (venda presencial).
// As credenciais ficam cifradas no banco (utils/cofreCredenciais.js).
//
// Retornos dos bancos: POST /api/pagamentos/webhook/<provedor>, e a
// conciliação automática (pagamentoController.conciliarPendentes) consulta as
// cobranças em aberto para os bancos sem webhook.
//
// Sem banco configurado, PIX online e cartão online ficam indisponíveis no
// checkout e os pedidos seguem pelo fluxo manual (Time Financeiro confirma).
import modelo from "./modelo.js";
import mercadopago from "./mercadopago.js";
import sumup from "./sumup.js";
import stone from "./stone.js";
import { configPagamentos, provedorDoCanal } from "./config.js";

export const PROVEDORES = { mercadopago, sumup, stone };

export const obterProvedor = (nome) => PROVEDORES[nome] || (nome === "modelo" ? modelo : null);

const ativoNoCanal = (canal) => {
  const nome = provedorDoCanal(canal) || (canal === "online" ? process.env.PAGAMENTO_PROVEDOR : null);
  const provedor = PROVEDORES[nome];
  return provedor && provedor.canais.includes(canal) && provedor.configurado() ? provedor : null;
};

export const provedorAtivo = () => ativoNoCanal("online");
export const provedorMaquininha = () => ativoNoCanal("maquininha");

export const statusPagamentos = () => {
  const online = provedorAtivo();
  const maquininha = provedorMaquininha();
  return {
    habilitado: Boolean(online),
    provedor: online?.nome || null,
    provedorRotulo: online?.rotulo || null,
    metodos: online?.metodos || [],
    maquininha: {
      habilitado: Boolean(maquininha),
      provedor: maquininha?.nome || null,
      provedorRotulo: maquininha?.rotulo || null,
      quantidade: maquininha ? configPagamentos().maquininhas.filter((m) => m.provedor === maquininha.nome && m.ativa !== false).length : 0,
    },
  };
};
