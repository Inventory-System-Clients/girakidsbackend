import { emitirNota, montarTxt, prepararNota } from "../services/nfeEmissaoService.js";
import { emitenteDaUltimaNota } from "../services/nfemailService.js";
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
