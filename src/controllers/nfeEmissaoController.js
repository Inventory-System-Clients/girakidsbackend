import { baixarDanfeDoPedido, emitirNota, lerVinculosCategorias, montarTxt, prepararNota, salvarVinculosCategorias } from "../services/nfeEmissaoService.js";
import { emitenteDaUltimaNota, listarProdutosNFeMail } from "../services/nfemailService.js";
import { responderErro } from "../utils/helpers.js";

// Prévia da NF-e do pedido (CFOP, ICMS, itens, transporte, pagamento) com as
// opções escolhidas na tela; nada é enviado.
export const previa = async (req, res) => {
  try {
    const nota = await prepararNota(req.params.id, req.body || {});
    // Arquivo que seria enviado (conferência), só quando a nota está completa.
    const txt = nota.bloqueios.length ? null : montarTxt(nota, await emitenteDaUltimaNota());
    res.json({ ...nota, txt });
  } catch (error) {
    responderErro(res, error, "Erro ao montar a nota fiscal");
  }
};

export const emitir = async (req, res) => {
  try {
    res.json(await emitirNota(req.params.id, req.body || {}, req.usuario));
  } catch (error) {
    responderErro(res, error, "Erro ao emitir a nota fiscal");
  }
};

// Vínculo categoria do site → produto da NFeMail.
export const vinculosCategorias = async (req, res) => {
  try {
    const produtos = await listarProdutosNFeMail();
    res.json({
      vinculos: await lerVinculosCategorias(),
      produtosNFeMail: produtos.map((p) => ({ codigo: String(p.cod_produto), alternativo: p.cod_alternativo, nome: p.dsc_produto, ncm: p.ncm_produto, unidade: p.cod_unidade, valor: Number(p.val_comercial || 0), inativo: Boolean(p.inf_inativo) })),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar os vínculos da nota fiscal");
  }
};

export const salvarVinculos = async (req, res) => {
  try {
    res.json({ vinculos: await salvarVinculosCategorias(req.body?.vinculos) });
  } catch (error) {
    responderErro(res, error, "Erro ao salvar os vínculos da nota fiscal");
  }
};

export const danfe = async (req, res) => {
  try {
    res.json(await baixarDanfeDoPedido(req.params.id, req.usuario));
  } catch (error) {
    responderErro(res, error, "Erro ao baixar a DANFE");
  }
};
