import { readFileSync } from "node:fs";

export { TiduError, type TiduErrorCode, type TiduErrorOptions } from "./errors.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export const PRODUCT = Object.freeze({
  name: "九门赛博提督",
  explanation: "九门赛博提督·智能协作中枢",
  positioning:
    "九门赛博提督是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。",
  version: packageMetadata.version,
});

export type ProductMetadata = typeof PRODUCT;
