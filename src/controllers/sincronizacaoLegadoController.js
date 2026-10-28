import { LogAtividade } from "../models/index.js";
import * as sincronizacao from "../services/sincronizacaoLegadoService.js";
import { responderErro } from "../utils/helpers.js";

// Sincronização com o sistema antigo (aba só do ADMIN). Sem registrarLog com
// o corpo: ele gravaria a senha do sistema antigo — aqui registra só o que mudou.

export const soAdmin = (req, res, next) =>
  req.usuario?.role === "ADMIN" ? next() : res.status(403).json({ error: "Só o administrador configura a sincronização com o sistema antigo." });

const registrar = (req, acao, detalhes) =>
  LogAtividade.create({
    usuarioId: req.usuario?.id,
    acao,
    entidade: "SistemaAntigo",
    detalhes,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  }).catch((err) => console.error("Erro ao criar log:", err));

export const status = async (req, res) => {
  try {
    res.json(await sincronizacao.obterStatus());
  } catch (error) {
    responderErro(res, error, "Erro ao carregar a sincronização");
  }
};

export const salvar = async (req, res) => {
  try {
    const corpo = req.body || {};
    const config = await sincronizacao.salvarConfig(corpo, req.usuario?.nome);
    const campos = Object.keys(corpo).filter((c) => c !== "senha" || String(corpo.senha || "").trim());
    registrar(req, "CONFIG_SINCRONIZACAO_LEGADO", { campos, ...(corpo.ativo !== undefined ? { ativo: Boolean(corpo.ativo) } : {}) });
    res.json(config);
  } catch (error) {
    responderErro(res, error, "Erro ao salvar a sincronização");
  }
};

export const executar = async (req, res) => {
  try {
    const resultado = await sincronizacao.sincronizarAgora();
    registrar(req, "SINCRONIZAR_LEGADO", { pedidosNovos: resultado.pedidosNovos?.length || 0, ok: resultado.ok });
    res.json(resultado);
  } catch (error) {
    responderErro(res, error, "Erro ao sincronizar com o sistema antigo");
  }
};
