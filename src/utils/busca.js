import { Op } from "sequelize";
import { sequelize } from "../database/connection.js";

// Buscas que ignoram acentos e maiúsculas/minúsculas ("pelucia" acha
// "Pelúcia"). f_unaccent é criada em database/migrate.js. Em consultas com
// include, passe a coluna qualificada (ex.: "Pedido.clienteNome").
export const contem = (coluna, termo) =>
  sequelize.where(sequelize.fn("f_unaccent", sequelize.col(coluna)), Op.like, sequelize.fn("f_unaccent", `%${termo}%`));

// Expressão SQL de "começa com" para ordenar resultados (coluna sem aspas).
export const comecaComSql = (coluna, termo) => `f_unaccent("${coluna}") LIKE f_unaccent(${sequelize.escape(`${termo}%`)})`;
