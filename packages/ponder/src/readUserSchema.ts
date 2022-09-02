import { buildSchema, GraphQLSchema } from "graphql";
import { readFile } from "node:fs/promises";

import { CONFIG } from "./config";

const schemaHeader = `
"Directs the executor to process this type as a Ponder entity."
directive @entity(
  immutable: Boolean = false
) on OBJECT

scalar BigDecimal
scalar Bytes
scalar BigInt
`;

const readUserSchema = async (): Promise<GraphQLSchema> => {
  const schemaBody = await readFile(CONFIG.SCHEMA_FILE_PATH);
  const schemaSource = schemaHeader + schemaBody.toString();
  const schema = buildSchema(schemaSource);

  return schema;
};

export { readUserSchema };
