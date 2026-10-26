// Formas de pagamento da loja. "online" = cobrada pelo banco/gateway
// configurado em src/services/pagamentos (PIX QR Code, cartão online);
// "admin" = só a equipe interna escolhe no checkout; "outros" = liberadas ao
// cliente quando o cadastro dele tem "Outros pagamentos" habilitado.
export const FORMAS_PAGAMENTO = {
  PIX_ONLINE: { nome: "PIX online", online: true, taxa: 0 },
  CREDITO_ONLINE: { nome: "Crédito online", online: true, cartao: true },
  DEBITO_ONLINE: { nome: "Débito online", online: true, taxa: 0.85 },
  // Cliente pode escolher; o comercial envia o link do cartão depois.
  CREDITO_LINK: {
    nome: "Crédito link",
    cartao: true,
    contatoComercial: true,
    aviso: "Depois de finalizar, fale com o comercial no WhatsApp para receber o link de pagamento do cartão.",
  },
  LINK_PAGAMENTO: { nome: "Link de pagamento", admin: true, cartao: true },
  MAQUININHA: { nome: "Maquininha", admin: true, cartao: true },
  PIX_PRESENCIAL: { nome: "PIX presencial", admin: true, taxa: 0 },
  DINHEIRO: { nome: "Dinheiro", outros: true, taxa: 0 },
  BOLETO: { nome: "Boleto", admin: true, taxa: 0 },
  CHEQUE: { nome: "Cheque", admin: true, taxa: 0 },
  TRANSFERENCIA: { nome: "Transferência Bancária", admin: true, taxa: 0 },
  PERMUTA: { nome: "Permuta", admin: true, taxa: 0 },
  A_RECEBER: { nome: "A receber", admin: true, taxa: 0 },
  A_DEFINIR: { nome: "A definir", admin: true, taxa: 0 },
  MESCLA: { nome: "Mescla de pagamentos", admin: true, taxa: 0 },
};

// Formas "admin" que o totem do showroom também pode usar (além das do cliente).
export const FORMAS_SHOWROOM = ["MAQUININHA", "LINK_PAGAMENTO", "PIX_PRESENCIAL", "A_RECEBER", "MESCLA"];

// Taxa (%) do cartão de crédito por número de parcelas. Pode ser trocada em
// Configurações (chave "taxasCartao") conforme o contrato com o banco.
export const TAXAS_CARTAO_PADRAO = {
  1: 3.15,
  2: 4.39,
  3: 5.19,
  4: 5.99,
  5: 6.79,
  6: 7.59,
  7: 8.39,
  8: 9.19,
  9: 9.99,
  10: 10.79,
  11: 11.59,
  12: 12.39,
};

export const METODOS_ENVIO = {
  RETIRAR_LOCAL: "Retirar no local",
  TRANSPORTADORA: "Transportadora",
  PAC: "PAC - Correios",
  SEDEX: "SEDEX - Correios",
};

// Endereço de retirada (pode ser trocado em Configurações: "enderecoLoja").
export const ENDERECO_LOJA_PADRAO = "Avenida Cachoeira Paulista, 17";

export const nomeFormaPagamento = (codigo) =>
  FORMAS_PAGAMENTO[codigo]?.nome || codigo || "-";
