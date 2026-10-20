export const somenteDigitos = (valor) => String(valor || "").replace(/\D/g, "");

export const arredondar = (valor, casas = 2) => {
  const fator = 10 ** casas;
  return Math.round((Number(valor) || 0) * fator + Number.EPSILON) / fator;
};

export const numero = (valor) => {
  if (valor == null || valor === "") return 0;
  if (typeof valor === "number") return valor;
  // Aceita "1.234,56" e "1234.56".
  const texto = String(valor).trim();
  const normalizado = texto.includes(",")
    ? texto.replace(/\./g, "").replace(",", ".")
    : texto;
  return Number(normalizado) || 0;
};

const digitosRepetidos = (d) => /^(\d)\1+$/.test(d);

export const cpfValido = (valor) => {
  const d = somenteDigitos(valor);
  if (d.length !== 11 || digitosRepetidos(d)) return false;
  const calc = (fim) => {
    let soma = 0;
    for (let i = 0; i < fim; i += 1) soma += Number(d[i]) * (fim + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
};

export const cnpjValido = (valor) => {
  const d = somenteDigitos(valor);
  if (d.length !== 14 || digitosRepetidos(d)) return false;
  const calc = (tamanho) => {
    const pesos = tamanho === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((acc, peso, i) => acc + Number(d[i]) * peso, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
};

export const documentoValido = (valor) => {
  const d = somenteDigitos(valor);
  return d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
};

export const erroHttp = (status, mensagem) => {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
};

export const responderErro = (res, error, padrao = "Erro interno") => {
  if (!error.status || error.status >= 500) console.error(padrao, error);
  res.status(error.status || 500).json({ error: error.message || padrao });
};

// Datas no fuso de Brasília. "AAAA-MM-DD" → início/fim do dia em -03:00.
export const inicioDoDia = (data) => new Date(`${data}T00:00:00.000-03:00`);
export const fimDoDia = (data) => new Date(`${data}T23:59:59.999-03:00`);

export const hojeISO = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

export const dataISO = (data) =>
  new Date(data).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
