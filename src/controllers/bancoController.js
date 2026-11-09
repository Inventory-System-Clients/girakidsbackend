import { lerConfiguracao, salvarConfiguracao } from "../models/Configuracao.js";
import { erroHttp, responderErro } from "../utils/helpers.js";

// Bancos que recebem os pagamentos dos pedidos (escolhidos ao confirmar
// pagamento, quitar pendência ou registrar recebimento). A equipe pode criar
// outros na própria tela; os padrões sempre aparecem.
export const BANCOS_PADRAO = ["Bancos GK", "Banco Leonardo", "Rede parceiro Itau"];
const CHAVE = "bancosRecebedores";

export const listarBancosRecebedores = async () => {
  const salvos = (await lerConfiguracao(CHAVE)) || [];
  return [...new Set([...BANCOS_PADRAO, ...salvos])];
};

// Nome do banco informado num recebimento: vazio = não informado; precisa
// estar cadastrado.
export const bancoValido = async (banco) => {
  const nome = String(banco || "").trim();
  if (!nome) return null;
  const lista = await listarBancosRecebedores();
  const achado = lista.find((b) => b.toLowerCase() === nome.toLowerCase());
  if (!achado) throw erroHttp(400, "Banco recebedor não cadastrado.");
  return achado;
};

export const listar = async (req, res) => {
  try {
    res.json(await listarBancosRecebedores());
  } catch (error) {
    responderErro(res, error, "Erro ao listar bancos");
  }
};

export const criar = async (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim().replace(/\s+/g, " ").slice(0, 100);
    if (nome.length < 2) throw erroHttp(400, "Informe o nome do banco.");
    const lista = await listarBancosRecebedores();
    if (lista.some((b) => b.toLowerCase() === nome.toLowerCase())) throw erroHttp(409, "Esse banco já está cadastrado.");
    const salvos = (await lerConfiguracao(CHAVE)) || [];
    await salvarConfiguracao(CHAVE, [...salvos, nome]);
    res.status(201).json({ nome, bancos: await listarBancosRecebedores() });
  } catch (error) {
    responderErro(res, error, "Erro ao criar banco");
  }
};
