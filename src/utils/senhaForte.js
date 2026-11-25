// Senha de administrador: não aceita senhas fáceis de adivinhar (123456,
// 12345678, "senha123", nome da loja...). Quem entra como admin vê e altera
// tudo, então a senha precisa resistir a tentativas automáticas.

const COMUNS = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890", "0123456789", "987654321", "87654321", "654321",
  "111111", "11111111", "000000", "00000000", "123123", "12341234", "123123123", "112233", "121212", "123321",
  "senha", "senha123", "senha1234", "senha12345", "minhasenha", "mudar123", "trocar123",
  "password", "password1", "password123", "passw0rd", "admin", "admin123", "admin1234", "administrador", "root",
  "qwerty", "qwerty123", "qwertyuiop", "asdfgh", "asdfghjk", "abc123", "abcd1234", "abc12345", "iloveyou",
  "brasil", "brasil123", "teste", "teste123", "teste1234", "123mudar", "girakids", "girakids123", "gira123",
]);

const SEQUENCIAS = ["0123456789", "9876543210", "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Devolve o motivo de a senha ser fraca, ou null se estiver ok.
export const problemaSenhaAdmin = (senha, { email, nome } = {}) => {
  const s = String(senha || "");
  const t = semAcento(s);
  if (s.length < 10) return "Senha de administrador deve ter no mínimo 10 caracteres.";
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return "Senha de administrador deve ter letras e números.";
  if (COMUNS.has(t) || COMUNS.has(t.replace(/[^a-z0-9]/g, ""))) return "Essa senha é muito comum e fácil de adivinhar. Escolha outra.";
  if (/^(.)\1+$/.test(t) || new Set(t).size < 5) return "Senha com poucos caracteres diferentes. Misture mais letras e números.";
  // Trechos longos de sequência (123456, abcdef, qwerty) ou repetição (aaaa).
  for (const seq of SEQUENCIAS) {
    for (let i = 0; i + 6 <= seq.length; i++) {
      if (t.includes(seq.slice(i, i + 6))) return "Senha não pode ter sequências como 123456, abcdef ou qwerty.";
    }
  }
  if (/(.)\1{3,}/.test(t)) return "Senha não pode repetir o mesmo caractere 4 vezes seguidas.";
  if (/girakids|gira\s*kids/.test(t)) return "Senha não pode conter o nome da loja.";
  const usuarioEmail = semAcento(String(email || "").split("@")[0]);
  if (usuarioEmail.length >= 4 && t.includes(usuarioEmail)) return "Senha não pode conter o seu e-mail.";
  for (const parte of semAcento(nome).split(/\s+/)) {
    if (parte.length >= 4 && t.includes(parte)) return "Senha não pode conter o seu nome.";
  }
  return null;
};
