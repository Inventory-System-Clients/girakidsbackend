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
import { configPagamentos, ordemProvedores, provedorDoCanal } from "./config.js";

export const PROVEDORES = { mercadopago, sumup, stone };

export const obterProvedor = (nome) => PROVEDORES[nome] || (nome === "modelo" ? modelo : null);

// Banco de cada canal: o escolhido pelo admin; sem escolha ("automático"),
// o único banco com credenciais (ou o cadastrado primeiro, se houver vários).
// "desligado" desliga o canal.
const prontoPara = (canal, provedor) => Boolean(provedor && provedor.canais.includes(canal) && provedor.configurado());

const ativoNoCanal = (canal) => {
  const escolha = provedorDoCanal(canal);
  if (escolha === "desligado") return null;
  const escolhido = PROVEDORES[escolha || (canal === "online" ? process.env.PAGAMENTO_PROVEDOR : "")];
  if (prontoPara(canal, escolhido)) return escolhido;
  const candidatos = [...ordemProvedores().map((n) => PROVEDORES[n]), ...Object.values(PROVEDORES)];
  return candidatos.find((p) => prontoPara(canal, p)) || null;
};

export const canalAutomatico = (canal) => {
  const escolha = provedorDoCanal(canal);
  return !escolha || (escolha !== "desligado" && !prontoPara(canal, PROVEDORES[escolha]));
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
    automatico: Boolean(online) && canalAutomatico("online"),
    maquininha: {
      habilitado: Boolean(maquininha),
      provedor: maquininha?.nome || null,
      provedorRotulo: maquininha?.rotulo || null,
      quantidade: maquininha ? configPagamentos().maquininhas.filter((m) => m.provedor === maquininha.nome && m.ativa !== false).length : 0,
    },
  };
};
