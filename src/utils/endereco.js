// Separa "logradouro + número + complemento" num texto só (formato usado
// pela loja antiga) em campos. Veio do giraKidsService do AgarraMais.
const PALAVRAS_COMPLEMENTO =
  /^(apto?|apt|ap|apartamento|sala|sl|bloco|bl|casa|cs|loja|lj|lote|lt|qd|quadra|fundos|frente|galp[aã]o|andar|conj(unto)?|cj|box|km|edif[ií]cio|ed|torre|ch[aá]cara|s[ií]tio|fazenda|condom[ií]nio|cond|t[eé]rreo|sobreloja|pavilh[aã]o|unidade|un|compl(emento)?|setor|res(idencial)?)\b/i;
const NUMERO = /^(\d+[A-Za-z]?|s\/?n|sn)$/i;

const limparComplemento = (texto) =>
  String(texto || "")
    .replace(/^[\s,.;:–-]+/, "")
    .replace(/[\s,;–-]+$/, "")
    .trim();

export const separarEndereco = (texto) => {
  const endereco = String(texto || "").replace(/\s+/g, " ").trim();
  if (!endereco) return { logradouro: "", numero: "", complemento: "" };

  // Com vírgula: "Logradouro, 123 - complemento"
  const virgula = endereco.indexOf(",");
  if (virgula > 0) {
    const logradouro = endereco.slice(0, virgula).trim();
    const resto = endereco.slice(virgula + 1).trim();
    const match = resto.match(/^(\d+[A-Za-z]?|s\/?n|sn)\b(.*)$/i);
    if (match) {
      return {
        logradouro,
        numero: match[1].toUpperCase().replace(/^SN$/, "S/N"),
        complemento: limparComplemento(match[2]),
      };
    }
  }

  // Sem vírgula: procura o número que vem no fim ou antes de uma palavra de
  // complemento (assim "Rua 7 de Setembro 120" não pega o 7).
  const partes = endereco.split(" ");
  const candidatos = partes
    .map((parte, indice) => ({ parte, indice }))
    .filter(({ parte, indice }) => indice > 0 && NUMERO.test(parte));

  const escolhido =
    candidatos.find(({ indice }) => {
      const resto = partes.slice(indice + 1).join(" ");
      return !resto || PALAVRAS_COMPLEMENTO.test(limparComplemento(resto));
    }) || candidatos[candidatos.length - 1];

  if (!escolhido) {
    return { logradouro: endereco, numero: "S/N", complemento: "" };
  }

  return {
    logradouro: partes.slice(0, escolhido.indice).join(" ").replace(/[,\s]+$/, ""),
    numero: escolhido.parte.toUpperCase().replace(/^SN$/, "S/N"),
    complemento: limparComplemento(partes.slice(escolhido.indice + 1).join(" ")),
  };
};
